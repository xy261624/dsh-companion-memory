#!/usr/bin/env python3
"""
sort_memory.py - 会话提取脚本（dsh 版）

从 dsh 的 zstd JSONL 会话日志里取出对话，按游标增量写进待整理目录，
供整理会话读取。

几个实现上的选择：

- 识别对方的话靠 user/message 事件里 data.source.kind == 'user'，
  注入的指令、工具结果、其他插件塞进来的消息都是别的 kind，不会误抓。
- 识别目标工作区靠会话头里的 cwd，不依赖 dsh 把路径编码成目录名的规则。
- 游标记的是每个会话"已经提取到的最大 seq"，比按时间戳判断更精确。
  游标文件默认放在 `<工作区>/.state/cursor.json`，它是运行状态，不用提交进 git，
  删掉之后下次会把能扫到的会话重新提一遍。
- dsh 0.2.0 之后新写的日志叫 session.v4.jsonl.zstd，老的是 session.jsonl.zstd。
  两种都认，版本高的优先。老会话被打开时会整份转成 v4 另存，seq 重新编号过，
  所以第一次换代时改用时间对齐，只提取游标之后的新内容，老内容不重复提。
- 对方在界面上归档的会话跳过，归档等于明确不要了。

用法：

    python sort_memory.py --workspace "D:\\your\\workspace"

第一次跑建议加 --since-days，否则历史会话会全部提取出来：

    python sort_memory.py --workspace "D:\\your\\workspace" --since-days 7

需要的依赖：

    pip install zstandard
"""

import argparse
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import zstandard

LOG_NAME_VERSIONS = (("session.v4.jsonl.zstd", 4), ("session.jsonl.zstd", 0))
USER_LABEL = "对方"
ROLE_LABEL = "角色"
# 整理会话自己的对话不进记忆，否则下一次整理要把上一次整理时说过的话再读一遍
DEFAULT_SKIP_TITLE_PREFIX = "📦 记忆整理"

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def ts_to_str(ts, tz_offset_hours=8):
    if not ts:
        return "未知"
    try:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc) + timedelta(hours=tz_offset_hours)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)


def decompress_prefix(path, limit=200_000, want=65_536):
    """解压文件前面的部分，够读第一行就行。解压中途出错也返回已经拿到的内容。"""
    try:
        with open(path, "rb") as f:
            data = f.read(limit)
        dctx = zstandard.ZstdDecompressor()
        reader = dctx.stream_reader(io.BytesIO(data), read_across_frames=True)
        chunks = []
        total = 0
        try:
            while total < want:
                chunk = reader.read(65_536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
        except Exception:
            pass
        return b"".join(chunks).decode("utf-8", errors="replace")
    except Exception:
        return ""


def read_session_log(path):
    """读完整的 zstd 多帧 JSONL，返回行列表。文件损坏时返回空列表。"""
    try:
        with open(path, "rb") as f:
            data = f.read()
        dctx = zstandard.ZstdDecompressor()
        text = dctx.stream_reader(io.BytesIO(data), read_across_frames=True).read().decode("utf-8", errors="replace")
        return [line for line in text.splitlines() if line.strip()]
    except Exception as e:
        print(f"   解压失败({e})，跳过这个会话")
        return []


def read_header(path):
    text = decompress_prefix(path)
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "session":
            return obj
    return None


def scan_sessions(sessions_root, workspace):
    """扫描会话目录，只保留 cwd 等于目标工作区的会话。"""
    sessions = {}
    if not os.path.isdir(sessions_root):
        print(f"[错误] 会话目录不存在: {sessions_root}")
        return sessions

    target = os.path.normcase(os.path.normpath(workspace))

    for project_dir_name in os.listdir(sessions_root):
        project_dir = os.path.join(sessions_root, project_dir_name)
        if not os.path.isdir(project_dir):
            continue

        for session_dir_name in os.listdir(project_dir):
            session_dir = os.path.join(project_dir, session_dir_name)
            if not os.path.isdir(session_dir):
                continue

            picked = None
            for name, version in LOG_NAME_VERSIONS:
                candidate = os.path.join(session_dir, name)
                if os.path.isfile(candidate):
                    picked = (version, candidate)
                    break
            if picked is None:
                continue

            version, log_path = picked
            header = read_header(log_path)
            if header is None:
                continue

            cwd = header.get("cwd") or ""
            if not cwd or os.path.normcase(os.path.normpath(cwd)) != target:
                continue

            lines = read_session_log(log_path)
            if not lines:
                continue

            sessions[header.get("id") or session_dir_name] = {
                "path": log_path,
                "version": version,
                "header": header,
                "lines": lines,
            }

    return sessions


def resolve_session_preset(header, lines):
    """
    读会话当前实际在用的模式。

    会话头里的 agentPreset 是建会话那一刻的默认模式，之后在界面上换过模式
    只会往日志里追加 agent-preset/selected 事件，头不会跟着变。所以先看事件的
    最后一条，一条都没有才退回看头。
    """
    selected = None
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "agent-preset/selected":
            continue
        preset = (obj.get("data") or {}).get("agentPreset")
        if isinstance(preset, str) and preset:
            selected = preset
    return selected or header.get("agentPreset") or ""


def is_real_session(header, lines, skip_presets):
    if header.get("origin") == "subagent":
        return False
    if (header.get("delegationDepth") or 0) > 0:
        return False
    if resolve_session_preset(header, lines) in skip_presets:
        return False
    return True


def read_archived_ids(workspace_state):
    try:
        with open(workspace_state, "r", encoding="utf-8") as f:
            state = json.load(f)
        return set(state.get("global", {}).get("archivedSessionIds", []))
    except Exception:
        return set()


def extract_dialogue(lines, from_seq=0, after_time=None):
    """
    取出双向对话，返回 [(seq, time, role, text)]。
    after_time 给了就按时间过滤，否则按 seq 过滤。
    """
    messages = []
    events = []
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if after_time is not None:
            if (obj.get("time") or 0) <= after_time:
                continue
        else:
            if obj.get("seq", 0) <= from_seq:
                continue
        events.append(obj)

    events.sort(key=lambda o: o.get("seq", 0))

    for obj in events:
        kind = obj.get("type")
        data = obj.get("data", {})

        if kind == "user/message":
            source = data.get("source", {})
            if source.get("kind") != "user":
                continue
            texts = [p["text"].strip() for p in data.get("content", [])
                     if p.get("type") == "text" and p.get("text", "").strip()]
            if texts:
                messages.append((obj.get("seq", 0), obj.get("time") or 0, "user", "\n".join(texts)))

        elif kind == "assistant/message":
            message = data.get("message", {})
            # 只取 text 块，reasoning 是思考过程，不进整理
            texts = [p["text"].strip() for p in message.get("content", [])
                     if p.get("type") == "text" and p.get("text", "").strip()]
            if texts:
                messages.append((obj.get("seq", 0), obj.get("time") or 0, "assistant", "\n".join(texts)))

    return messages


def max_message_seq(lines):
    m = 0
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") in ("user/message", "assistant/message"):
            s = obj.get("seq")
            if isinstance(s, int) and s > m:
                m = s
    return m


def get_session_title(lines):
    """会话可能改过名，取最后一条 title 事件。"""
    title = ""
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "session/title":
            found = (obj.get("data") or {}).get("title", "")
            if found:
                title = found
    return title


def read_cursor(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def write_cursor(path, cursor):
    ensure_dir(os.path.dirname(path) or ".")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cursor, f, ensure_ascii=False, indent=2)
    print(f"\n[游标] 已更新: {path}（{len(cursor)} 个会话）")


def write_pending_file(pending_dir, session_id, messages, header, preset, user_label=USER_LABEL, role_label=ROLE_LABEL):
    if not messages:
        return False

    ensure_dir(pending_dir)
    filepath = os.path.join(pending_dir, f"{session_id}.md")

    user_count = sum(1 for m in messages if m[2] == "user")
    role_count = sum(1 for m in messages if m[2] == "assistant")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"# {session_id}\n")
        f.write(f"创建: {ts_to_str(header.get('createdAt', 0))}\n")
        f.write(f"目录: {header.get('cwd', '')}\n")
        f.write(f"模式: {preset}\n")
        f.write(f"消息数: {len(messages)}（{user_label} {user_count} 条 / {role_label} {role_count} 条）\n")
        f.write(f"提取时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write("\n---\n\n")

        for seq, ts, role, text in messages:
            who = user_label if role == "user" else role_label
            f.write(f"### [{ts_to_str(ts)}] {who}\n")
            f.write(f"{text}\n\n")

    size = os.path.getsize(filepath)
    if size > 51200:
        print(f"   注意：文件 {size / 1024:.0f}KB，超过 read 工具单次显示上限，可能被截断")

    print(f"  [写入] {filepath}（{len(messages)} 条：{user_label} {user_count} / {role_label} {role_count}）")
    return True


def main():
    parser = argparse.ArgumentParser(description="从 dsh 会话日志提取对话到待整理目录")
    parser.add_argument("--workspace", default=None,
                        help="工作区目录。省略时取脚本所在目录的上一层，脚本放在 <工作区>/scripts/ 下就能直接跑")
    parser.add_argument("--sessions-root", default=None, help="默认 ~/.dsh/sessions")
    parser.add_argument("--cursor", default=None, help="默认 工作区/.state/cursor.json")
    parser.add_argument("--pending", default=None, help="默认 工作区/待整理")
    parser.add_argument("--workspace-state", default=None, help="默认 ~/.dsh/storages/workspace.json")
    parser.add_argument("--skip-presets", nargs="*", default=[], help="这些模式的会话不提取，多个用空格隔开")
    parser.add_argument("--skip-title-prefix", default=DEFAULT_SKIP_TITLE_PREFIX,
                        help="标题以这些前缀开头的会话不提取，多个用逗号隔开。默认跳过整理会话自己")
    parser.add_argument("--since-days", type=float, default=None,
                        help="只提取最近这么多天内的对话。第一次跑建议加上，不然会把历史会话全提出来")
    parser.add_argument("--user-label", default=USER_LABEL, help="待整理文件里怎么称呼被整理的那个人，填模板里【称呼】换下来的叫法")
    parser.add_argument("--role-label", default=ROLE_LABEL, help="待整理文件里怎么称呼角色自己，填模板里【角色】换下来的名字")
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace) if args.workspace else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    skip_prefixes = tuple(p.strip() for p in (args.skip_title_prefix or "").split(",") if p.strip())
    sessions_root = args.sessions_root or os.path.expanduser(os.path.join("~", ".dsh", "sessions"))
    cursor_file = args.cursor or os.path.join(workspace, ".state", "cursor.json")
    pending_dir = args.pending or os.path.join(workspace, "待整理")
    workspace_state = args.workspace_state or os.path.expanduser(os.path.join("~", ".dsh", "storages", "workspace.json"))
    skip_presets = tuple(args.skip_presets)

    since_time = None
    if args.since_days is not None:
        since_time = int((datetime.now(timezone.utc).timestamp() - args.since_days * 86400) * 1000)

    print("=" * 50)
    print("  会话提取")
    print(f"  工作区: {workspace}")
    print(f"  运行时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)

    ensure_dir(pending_dir)
    ensure_dir(os.path.dirname(cursor_file) or ".")

    if not os.path.exists(cursor_file) and args.since_days is None:
        print("\n[提示] 游标文件还不存在，这次会把所有历史会话都提取出来。")
        print("       只想处理最近的对话的话，加上 --since-days 7 之类的参数重跑。")

    print("\n[1/4] 扫描会话日志...")
    sessions = scan_sessions(sessions_root, workspace)
    if not sessions:
        print("  没有找到属于这个工作区的会话")
        return

    v4_count = sum(1 for info in sessions.values() if info["version"] >= 4)
    real_sessions = {sid: info for sid, info in sessions.items()
                     if is_real_session(info["header"], info["lines"], skip_presets)}
    print(f"  找到 {len(sessions)} 个会话（v4 格式 {v4_count} 个），可整理 {len(real_sessions)} 个")

    archived_ids = read_archived_ids(workspace_state)
    final_sessions = {sid: info for sid, info in real_sessions.items() if sid not in archived_ids}
    skipped_archived = len(real_sessions) - len(final_sessions)
    if skipped_archived:
        print(f"  已归档跳过 {skipped_archived} 个")

    print("\n[2/4] 读取游标...")
    cursor = read_cursor(cursor_file)
    print(f"  已记录 {len(cursor)} 个会话")

    print("\n[3/4] 增量提取...")
    new_cursor = {}
    processed = 0
    total_msgs = 0
    upgraded = 0

    for sid, info in final_sessions.items():
        header = info["header"]
        lines = info["lines"]
        is_v4 = info["version"] >= 4
        prev = cursor.get(sid) if isinstance(cursor.get(sid), dict) else None
        title = get_session_title(lines)

        # 整理会话自己的对话不提取
        if skip_prefixes and any(title.startswith(p) for p in skip_prefixes):
            if sid in cursor:
                new_cursor[sid] = cursor[sid]
            continue

        if prev is None:
            messages = extract_dialogue(lines, 0, after_time=since_time)
            write_all = True
        elif is_v4 and prev.get("version") != 4:
            # 换代：老 seq 和 v4 的编号对不上，改用时间对齐
            upgraded += 1
            messages = extract_dialogue(lines, after_time=prev.get("last_time", 0))
            write_all = False
        else:
            messages = extract_dialogue(lines, prev.get("max_seq", 0))
            write_all = True

        if not messages:
            # 没有新内容：游标保持不变，只把代际跟上面。
            # 首次运行要特别处理：这次没提取到东西，说明这段时间之前的都算看过了，
            # 把 max_seq 记成日志里的最大值，下次不再重复扫。
            base_max = prev.get("max_seq", 0) if prev else 0
            if prev is None or (is_v4 and prev.get("version") != 4):
                base_max = max_message_seq(lines)
            prev_time = prev.get("last_time", 0) if prev else 0
            new_cursor[sid] = {
                "max_seq": base_max,
                "last_time": prev_time or header.get("createdAt", 0),
                "version": 4 if is_v4 else 0,
            }
            continue

        # 待整理文件写完整对话，保证整理时有上下文。
        # 换代那一次例外：老内容早就整理过，只写这波增量。
        if write_all and prev is not None:
            messages = extract_dialogue(lines, 0)

        preset = resolve_session_preset(header, lines)
        print(f"\n  --- {sid} ---")
        if title:
            print(f"  标题: {title}")
        print(f"  模式: {preset}  创建: {ts_to_str(header.get('createdAt'))}")

        ok = write_pending_file(pending_dir, sid, messages, header, preset, args.user_label, args.role_label)
        if ok:
            processed += 1
            total_msgs += len(messages)
            new_cursor[sid] = {
                "max_seq": max(m[0] for m in messages),
                "last_time": messages[-1][1],
                "version": 4 if is_v4 else 0,
            }
        else:
            base_max = prev.get("max_seq", 0) if prev else 0
            prev_time = prev.get("last_time", 0) if prev else 0
            new_cursor[sid] = {
                "max_seq": base_max,
                "last_time": prev_time or header.get("createdAt", 0),
                "version": 4 if is_v4 else 0,
            }

    # 归档跳过的会话保留游标原值，将来取消归档时不会从头重提
    for sid in real_sessions:
        if sid not in final_sessions and sid in cursor:
            new_cursor[sid] = cursor[sid]

    if processed == 0:
        print("  没有新的会话需要整理")
    else:
        print(f"\n  已提取 {processed} 个会话，共 {total_msgs} 条消息")
    if upgraded:
        print(f"  （其中 {upgraded} 个是老会话刚换成 v4 格式，只提了增量）")

    print("\n[4/4] 更新游标...")
    write_cursor(cursor_file, new_cursor)

    print("\n" + "=" * 50)
    print(f"  完成，待整理内容在 {pending_dir}")
    print("=" * 50)


if __name__ == "__main__":
    main()
