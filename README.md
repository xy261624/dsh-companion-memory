# dsh-companion-memory

DeepSeek Harness 的跨会话记忆与主动唤醒方案，面向角色扮演和长期陪伴场景。

## 快速开始

```sh
dsh plugin --profile web add github:xy261624/dsh-companion-memory
dsh --profile web
```

包自带挂载声明，装完心跳和自动整理这两个插件就挂上了。装完还有三件事：

1. 给模式加一条 `agent-instructions`，把常驻记忆文件列进注入名单。手上还没有自己的模式，就先照下文「怎么配这个模式」建一个
2. 建工作区目录、把包里的模板和脚本复制进去。装完的包在 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-companion-memory\` 底下，哪个文件该放到哪儿，照[上手](./docs/05-上手.md)第二节那张对照表做，一共七行，别漏
3. 把 `defaultPreset` 和 `sortPreset` 改成你环境里存在的模式 id。两个插件默认写的 `default` 在 dsh 里并不存在，名字对不上时会话开不出来，只在日志里留一行错误。在 profile 的 `cordis.patch.yml` 末尾写这两段：

```yaml
- id: companion-memory-heartbeat
  config:
    defaultPreset: my-mode

- id: companion-memory-auto-sort
  config:
    sortPreset: my-mode
```

profile 默认叫 `web`，文件在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`。这两条 id 是包自己挂进来的，profile 里原本没有这两段，所以是新写，不是改现成的。填的是模式声明里 `config.id` 那个值（比如 `my-mode`），不是 `- id: preset-my-mode` 那一行的 id。模式 id 在设置页的预设卡片上，标题旁边就是

细节见[上手](./docs/05-上手.md)。

## 功能

### 跨会话记忆

每次开会话时，`STATUS.md`（当前状态）和 `MEMORY.md`（对方的基本属性）会自动注入上下文——前提是这个模式里挂了 `agent-instructions`，也就是「怎么配这个模式」那节做的事。前者记录最近发生的事，后者记录不会变的事。

其余细节放在记忆库目录，按索引读取。

整理可以手动触发；自动整理插件装上就在跑，条件到了会自己开整理会话。

### 面向 RP 场景的记忆写法

现有记忆插件的记忆文件多为技术文档式记录：条目化、客观、平铺直叙。这种写法适合让 agent 查资料，在 RP 场景里会降低角色的情感表现力。角色读到的是"用户在某个时间提到过某件事"这样的句子，没有语气、情绪和当时的语境，回话也带不出情感浓度。

本方案中记忆文件按角色视角写，记录角色看到的内容，使用角色会用的说法，保留原话、语气和体现情绪的细节。

记忆文件里不写"他""对方"这类中性指代，用角色对他的称呼来写，情感浓度靠这个撑起来。

人格本身不在记忆文件里，写在模式（preset）的提示词里。

#### 说明

本仓库不提供角色人设。人格由 DeepSeek Harness 的 agent preset 提供，一个 preset 是一套人设提示词和工具配置。称呼相同的 preset 可以共用一套记忆文件，称呼不同的各用一套。

常驻记忆文件放在工作区根目录，在模式的插件列表里加一条 `agent-instructions`。这条是 dsh 随包的插件，不用另外安装：

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
    instructionFileCandidates:
      - AGENTS.md
      - MEMORY.md
      - STATUS.md
```

`instructionFileCandidates` 是整体替换而非追加，默认值为 `AGENTS.md` 和 `CLAUDE.md`；这两个名字不列进去，工作区原有的同名文件就不再注入。要加别的常驻文件，往后接着列即可。`~/.dsh/AGENTS.md` 那份全局指令不在这份名单里，无论怎么配都会注入。

`maxBytes` 是所有命中文件合计的字节预算，不是每份各算一份。超预算时靠后的文件被整体省略，或者单份被截断，注入文本开头会带一行说明，写明哪个文件从多少字节截到多少字节。

注入发生在每个会话的第一次请求之前，之后固定不动。改完文件要开新会话才读得到，正在进行的会话里看不到变化。

#### 怎么配这个模式

模式是一条 `@deepseek-ai/dsh-agent-preset` 声明，`id` 是模式标识，`plugins` 是它的插件列表。新建的时候整条声明要包在 `insert:` 下面，直接平铺不会被认出来：

```yaml
- insert:
    - id: preset-my-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: my-mode
        name: 我的模式
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: 你叫某某，是……
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
              instructionFileCandidates:
                - AGENTS.md
                - MEMORY.md
                - STATUS.md
```

人设写在 `persona` 那条的 `config.prefix` 里。`persona` 也是 dsh 随包的插件，不用另外安装。`prefix` 就是一段纯文本，没有长度限制；文本里的 `{{model}}` 和 `{{cwd}}` 会被替换成当前模型名和工作目录。想让人设覆盖掉 dsh 默认那句身份说明，在同一条 `config` 里加一个 `complete: true`。

`agent-instructions` 写进同一个 `plugins` 列表，dsh 自带的两个模式都把它排在 `persona` 后面。

**新建模式**：在工作区建一个目录，里面放两个文件——`package.json` 写 `{"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}`，`cordis.patch.yml` 写上面那条声明。这里的 `cordis.patch.yml` 跟 profile 里那份同名的不是一回事：profile 那份管整个 dsh 的组合，这份只管这个组合包要往组合里加什么。然后打开 Web 界面的设置页 → 预设，那块有个创造入口，点进去会开一个使用 `cordis` 模式的新会话；把目录路径告诉它、说要装这个组合包，它用 `plugin_manager` 的 `install_bundle` 装好。

**改已有模式**：按 Loader 行 id 覆盖那条声明。覆盖时 `config` 整体替换、不做深层合并，插件列表必须完整重述，少一条即视为删除。完整列表不用手抄——设置页的预设卡片上有「查看配置」，点开是这个模式当前的声明，只读 YAML，复制下来改就行。

**生效**：装完或者改完都要重启 dsh，把进程退出再启动一次。只刷新页面不算，改的是启动时读的配置。

**平时怎么用**：装好的模式会出现在设置页的预设列表里，新建会话的时候选它，那个会话就带着这套人设和注入名单。想让所有新会话都用它，在预设区把它设成默认值。插件自己开的会话不看这个默认值，它们看 `defaultPreset` 和 `sortPreset`。

**以后要加常驻文件**：在工作区根目录放好文件，再改模式声明里 `instructionFileCandidates` 那一串（整体替换，别把原有的挤掉），然后重新让创造入口装一遍那个组合包、重启 dsh。

Cordis 的写法不熟就别硬来，点那个创造入口把手上的事交给它，它带着官方那两份说明文档。

#### 怎么确认装好了

重启之后，看启动 dsh 那个终端窗口的输出，插件加载时各打一行：

```
heartbeat: plugin loaded
auto-sort: plugin loaded
```

没有这两行就是插件没挂上，先查 profile 名字和 `cordis.patch.yml` 里那两段还在不在。其中 `auto-sort: plugin loaded` 这一行，如果你按第五节把自动整理关掉了，本来就不会有，别当成没装上。

再看工作区，`.state/` 目录会被建出来，里面放着会话指纹和心跳用的模式文件。这个目录要等第一次写状态文件时才出现，刚装完还没聊过天的时候可能还没有。

注入那条这样验：先在 `STATUS.md` 里加一行只有这个文件才有的字，比如 `验证标记：蓝色风车`，然后用配好的模式开一个新会话，问它这句话是什么。答得出来说明注进去了；答不上来，检查模式里的 `instructionFileCandidates` 有没有列这几个文件名、文件是不是放在工作区根目录。别拿文件标题去问，那种从文件名就能猜到。

### 索引-记忆库

不加控制的话记忆文件会持续增加，同一类场景和情绪被反复记录，角色每轮读到的内容高度相似，说话句式也跟着重复，最后固定在几种说法上。

索引-记忆库用于控制这个问题。记忆分四类：

| 类型 | 文件 | 内容 | 读取时机 |
|---|---|---|---|
| 状态 | `STATUS.md` | 最近聊了什么、正在忙什么、答应了什么没做 | 每会话自动注入 |
| 属性 | `MEMORY.md` | 作息、喜好、忌讳、生日 | 每会话自动注入 |
| 细节 | `记忆库/*.md` | 某件事的完整记录 | 按索引读取 |
| 叙事 | `回忆录-*.md` | 值得记住的经历，按故事写 | 很少读 |

`STATUS.md` 和 `MEMORY.md` 是常驻文件，只保留精炼条目，需要细节处写一行"详情在 `记忆库/xxx.md`"，使用时按路径读取。

细节是否在常驻文件里留索引，判断标准是"不读它会不会误事"。仅备查的内容只进记忆库。

单个文件超过 15KB 时按话题拆分。

这套设计针对三个问题：常驻文件膨胀占满上下文、同一件事在几份文件里重复记录、相似内容积累导致角色说话趋同。

### 自动整理

插件按固定周期检查新对话。存在新活动且距上次整理超过设定的静默时间时，开启一个整理会话。

整理会话的步骤：

1. 运行提取脚本，从会话日志中取出新对话
2. 读取这些对话
3. 按判断标准筛选，决定写入哪份文件
4. 逐条写入，并按规范自查
5. 开启审查子代理，用整理流程、写作规范（同一份文件第六节）、工作区模板三份基准逐条核对

审查子代理必须引用原文、标注严重程度、给出改法，输出一份整理者照着就能改的清单。

整理完成后，把下次要用的模式 id 写进状态文件 `heartbeat-preset.json`，心跳插件读它决定下次用哪个模式开口。

### 主动唤醒（心跳）

插件不等用户输入，自行选择时间开启会话。设计要点：

- 触发间隔不固定，随聊天频率变化，由概率曲线控制
- 睡眠时段内不触发
- 触发前做二次检查，确认期间没有新的对话
- 命中后随机延迟数秒至数分钟
- 会话开启后先读取状态文件，再决定本次行为
- 心跳会话默认带全权限，因为它常常在你不在电脑前的时候开，没法逐次批权限；可以在配置里改成更小的权限档

## 跟其他记忆插件的区别

| 常见做法 | 结果 | 本方案 |
|---|---|---|
| 自动抽取事实入库 | 存下来的是资料条目，角色说话仍像助手 | 由角色主动整理，按角色视角写 |
| 记忆一次性全部注入 | 上下文被占满，重要内容被稀释 | 常驻只放精炼条目，细节按索引读 |
| 全量堆在单个文件 | 文件越来越长，同一件事记多遍 | 常驻与文件库分离，超过 15KB 拆分 |
| 只存不查质量 | 记忆混入猜测、汇报腔、视角错误 | 独立子代理对抗式审查，输出修改清单 |
| 被动等待提问 | 不会主动开口 | 概率间隔的心跳，带睡眠时段和随机延迟 |
| 人格写进记忆 | 记忆里全是中性指代，读着像档案 | 人格放模式里，记忆用角色对他的称呼写 |

## 环境要求

- Node.js `^22.19.0 || >=24`
- DeepSeek Harness `0.2.0-rc.2`，在 web profile 上实测过，底下的 cordis 是 `4.0.4`。更高版本的正式版没有实测
- Python 3.8 以上，`pip install zstandard`

dsh 目前还在开发者预览阶段，插件的接口会跟着版本变。换版本之后如果心跳或者整理不工作了，先看插件有没有加载日志，再看模式 id 对不对。

## 安装

```sh
dsh plugin --profile web add github:xy261624/dsh-companion-memory
```

包里的 `cordis.patch.yml` 会自动把两个插件插进组合。不配 `workspace` 时用 dsh 里的第一个工作区；有多个工作区、想指定其中一个，在 profile 的 `cordis.patch.yml` 里补一段：

```yaml
- id: companion-memory-heartbeat
  config:
    workspace: D:/你的工作区

- id: companion-memory-auto-sort
  config:
    workspace: D:/你的工作区
```

两个插件都要配，只配一个的话另一个会退回 dsh 里的第一个工作区，两份模式状态文件就落到不同目录去了。

全部配置字段见 [docs/05-上手.md](./docs/05-上手.md)。

## 目录结构

```
package.json       插件包声明，指向 cordis.patch.yml
cordis.patch.yml   装完自动挂载两个插件
docs/              设计说明与流程文档
plugins/           两个 dsh 插件
  dsh-heartbeat/
  dsh-auto-sort/
scripts/           会话提取脚本
templates/         记忆文件模板
```

## 文档

- [设计哲学](./docs/01-设计哲学.md)
- [记忆架构](./docs/02-记忆架构.md)
- [整理流程](./docs/03-整理流程.md)
- [对抗式审查](./docs/04-对抗式审查.md)
- [上手](./docs/05-上手.md)
- [模板文件](./templates/)

## LICENSE

MIT
