// ============================================================
//  dsh-companion-memory · 自动整理插件
//
//  检测工作区里的会话静默一段时间之后，自动开一个整理会话，
//  把整理流程指给模型，让它把这几天的对话整理进记忆文件。
//
//  设计要点：
//   - 整理会话默认带全权限：它要写工作区外的预设文件、跑脚本，
//     而使用者常常不在电脑旁，没法逐次批权限。只影响这一个会话
//   - 整理完写一份预设文件，记下下次心跳用哪个模式开新会话，心跳插件读这个文件
//   - 会话指纹缓存：日志没变过的会话不重复读
// ============================================================

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const SOURCE_KIND = 'companion-memory-auto-sort'

function absolute(base, p) {
  return isAbsolute(p) ? p : join(base, p)
}

function resolveConfig(config = {}, ctx) {
  let workspacePath = config.workspace
  if (!workspacePath) {
    const workspaces = ctx.workspaceRegistry?.list?.() ?? []
    if (workspaces.length === 0) {
      throw new Error('companion-memory-auto-sort: 没有配置 workspace，dsh 里也没有工作区')
    }
    workspacePath = workspaces[0].path
    ctx.logger.info(`auto-sort: config.workspace 未配置，使用第一个工作区 ${workspacePath}`)
  }
  const workspace = resolve(workspacePath)
  const stateDir = config.stateDir ? absolute(workspace, config.stateDir) : join(workspace, '.state')
  return {
    workspace,
    stateFile: config.stateFile
      ? absolute(workspace, config.stateFile)
      : join(stateDir, 'auto-sort-state.json'),
    presetFile: config.presetFile
      ? absolute(workspace, config.presetFile)
      : join(stateDir, 'heartbeat-preset.json'),
    memoryGuide: config.memoryGuide ?? '记忆库/记忆系统说明.md',
    sortProcess: config.sortProcess ?? '整理流程.md',
    extractScript: config.extractScript ?? 'scripts/sort_memory.py',
    sortPreset: config.sortPreset ?? 'default',
    skipPresets: Array.isArray(config.skipPresets) ? config.skipPresets : [],
    checkIntervalMs: config.checkIntervalMs ?? 3 * 60 * 1000,
    quietThresholdMs: config.quietThresholdMs ?? 30 * 60 * 1000,
    permissionPreset: config.permissionPreset ?? 'danger-full-access',
    prompt: config.prompt ?? null,
    pythonCommand: config.pythonCommand ?? 'python',
  }
}

function defaultPrompt(cfg) {
  const guide = absolute(cfg.workspace, cfg.memoryGuide)
  const process = absolute(cfg.workspace, cfg.sortProcess)
  const script = absolute(cfg.workspace, cfg.extractScript)
  const skip = cfg.skipPresets.length > 0 ? ` --skip-presets ${cfg.skipPresets.join(' ')}` : ''
  return `📦 自动整理触发。按以下步骤执行：

1. 读 ${guide}，了解整套记忆体系和每份文件的作用
2. 运行整理脚本：${cfg.pythonCommand} "${script}" --workspace "${cfg.workspace}"${skip}
3. 读 ${process}，严格按里面的步骤执行
4. 本会话带全权限，权限只用于完成这次整理：除了记忆文件和心跳预设文件，别动别的

本会话由插件自动触发，📦 是占位符，不是对方本人发的消息。整理完成后把下次心跳要用的模式写进 ${cfg.presetFile}，不用问对方。`
}

export default {
  name: 'companion-memory-auto-sort',
  inject: ['timer', 'sessionPersistence', 'agents', 'agentPresets', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'permissionPresets'],

  async apply(ctx, rawConfig) {
    const CONFIG = resolveConfig(rawConfig, ctx)
    const logger = ctx.logger

    const readState = () => {
      try {
        const parsed = JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'))
        return {
          lastSortTime: Number(parsed.lastSortTime) || 0,
          revisions: parsed.revisions && typeof parsed.revisions === 'object' ? parsed.revisions : {},
        }
      } catch {
        return { lastSortTime: 0, revisions: {} }
      }
    }

    const writeState = (state) => {
      try {
        mkdirSync(dirname(CONFIG.stateFile), { recursive: true })
        writeFileSync(CONFIG.stateFile, JSON.stringify(state), 'utf-8')
      } catch {
        // 状态写不进去不影响功能
      }
    }

    const state = readState()
    let lastActiveTime = null
    let quietTimeMs = 0
    let checking = false
    let triggering = false
    let stateDirty = false

    const isValidTimestamp = (ts) => ts > 1000000000000

    const isWorkspaceSession = (header) => {
      const cwd = (header.cwd ?? '').replace(/\\/g, '/')
      return cwd === CONFIG.workspace.replace(/\\/g, '/')
    }

    // 读会话实际在用的模式。会话头里写的是建会话那一刻的默认模式，
    // 之后在界面上换过模式只会往日志里追加 agent-preset/selected 事件，
    // 头不会跟着变。所以先看事件里的最后一条，没有才退回看头。
    const resolveSessionPreset = (header, events) => {
      let selected = null
      for (const ev of events) {
        if (ev.type !== 'agent-preset/selected') continue
        const id = ev.data?.agentPreset
        if (typeof id === 'string' && id.length > 0) selected = id
      }
      return selected ?? header.agentPreset
    }

    // 最后活动时间。两种活动都算：
    //   1. 对方自己发的消息（source.kind === 'user'）
    //   2. 心跳注入的消息
    // 心跳期间做的事也要进记忆，否则下一次心跳不知道自己上次做过什么，
    // 会重复劳动甚至重写文件。
    const extractLastActivityTime = (events) => {
      let last = null
      for (const ev of events) {
        if (ev.type !== 'user/message') continue
        const src = ev.data?.source
        const isUserChat = src?.kind === 'user'
        const isOwnHeartbeat = src?.kind === 'companion-memory-heartbeat' ||
          src?.kind === 'plugin:companion-memory-heartbeat' ||
          (src?.kind === 'plugin' && src?.plugin === 'companion-memory-heartbeat')
        if (isUserChat || isOwnHeartbeat) {
          const ts = ev.time ?? ev.data?.time
          if (isValidTimestamp(ts)) last = Math.max(last ?? 0, ts)
        }
      }
      return last
    }

    const getLatestRealSessionTime = async () => {
      try {
        const snapshots = await ctx.sessionPersistence.list()
        if (!snapshots || snapshots.length === 0) return null

        let latest = null
        for (const snap of snapshots) {
          const header = snap.header
          if (!isWorkspaceSession(header)) continue
          if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) continue

          // 老格式会话跳过：读一次要跑一遍完整迁移，会话多了开销很大，
          // 而老格式的历史早已整理过，新活动只会出现在新格式里。
          const revKey = String(snap.revision ?? '')
          if (revKey.split(':').length > 5) continue

          const cached = state.revisions[header.id]
          if (revKey && cached && cached.rev === revKey) {
            if (cached.bad) continue
            if (cached.last != null) latest = Math.max(latest ?? 0, cached.last)
            continue
          }

          let events
          try {
            const reader = await ctx.sessionPersistence.open(header.id, 'read')
            try {
              events = (await reader.read()).events ?? []
            } finally {
              await reader.close()
            }
          } catch (err) {
            logger.warn(`auto-sort: read session ${header.id} failed: ${err?.message ?? err}`)
            if (revKey) {
              state.revisions[header.id] = { rev: revKey, bad: true }
              stateDirty = true
            }
            continue
          }

          // 跳过在 skipPresets 里的会话。模式要看日志事件里最后一条选的，
          // 所以这句必须放在读过事件之后。
          if (CONFIG.skipPresets.includes(resolveSessionPreset(header, events))) {
            if (revKey) {
              state.revisions[header.id] = { rev: revKey, last: null }
              stateDirty = true
            }
            continue
          }

          const lastActivityTime = extractLastActivityTime(events)
          if (revKey) {
            state.revisions[header.id] = { rev: revKey, last: lastActivityTime }
            stateDirty = true
          }
          if (lastActivityTime != null) latest = Math.max(latest ?? 0, lastActivityTime)
        }

        if (latest == null || !isValidTimestamp(latest)) return null
        return latest
      } catch (err) {
        logger.warn(`auto-sort: getLatestRealSessionTime failed: ${err?.message ?? err}`)
        return null
      }
    }

    const triggerSortSession = async (hoursSince) => {
      triggering = true
      try {
        const title = `📦 记忆整理 - ${new Date().toISOString().slice(0, 10)}`
        const sessionId = `session-${randomUUID()}`
        const selection = ctx.agentDefaultModel.currentSelection()

        const handle = await ctx.agents.create({
          sessionId,
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
          },
          meta: {
            cwd: CONFIG.workspace,
            agentPreset: CONFIG.sortPreset,
          },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
            await ctx.agentPresets.mount(agentCtx, CONFIG.sortPreset)
          },
        })

        try {
          const workspace = await ctx.workspaceRegistry.resolveByPath(CONFIG.workspace)
          if (workspace !== void 0) await workspace.attachSession(sessionId)
        } catch (err) {
          logger.warn(`auto-sort: attach workspace failed: ${err?.message ?? err}`)
        }

        try {
          ctx.permissionPresets.set(handle.agent.session, CONFIG.permissionPreset)
        } catch (err) {
          logger.warn(`auto-sort: set permission preset failed: ${err?.message ?? err}`)
        }

        try {
          ctx.sessionTitle.rename(handle.agent.session, title)
        } catch {
          // 标题设不上不影响功能
        }

        const text = CONFIG.prompt ?? defaultPrompt(CONFIG)

        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: SOURCE_KIND, plugin: SOURCE_KIND },
        })

        handle.agent.followup(message)
        logger.info(`auto-sort: created sort session ${title} (${sessionId}), ${(hoursSince ?? 0).toFixed(1)}h since last activity`)
      } catch (err) {
        logger.error(`auto-sort: trigger failed: ${err?.message ?? err}。检查 sortPreset "${CONFIG.sortPreset}" 是不是你环境里存在的模式 id。`)
      } finally {
        triggering = false
      }
    }

    const checkAndAct = async () => {
      if (checking || triggering) return
      checking = true
      try {
        const latestTime = await getLatestRealSessionTime()
        if (latestTime === null) return

        if (lastActiveTime === null || latestTime !== lastActiveTime) {
          lastActiveTime = latestTime
          quietTimeMs = 0
          return
        }

        quietTimeMs += CONFIG.checkIntervalMs

        // 静默够了，并且这段时间确实有新活动
        if (quietTimeMs >= CONFIG.quietThresholdMs && latestTime > state.lastSortTime) {
          // 先登记再触发，防止并发重复触发
          state.lastSortTime = Date.now()
          writeState(state)
          quietTimeMs = 0

          await triggerSortSession((Date.now() - latestTime) / 3600000)
        }
      } catch (err) {
        logger.warn(`auto-sort: check error: ${err?.message ?? err}`)
      } finally {
        if (stateDirty) {
          writeState(state)
          stateDirty = false
        }
        checking = false
      }
    }

    logger.info('auto-sort: plugin loaded')

    const dispose = ctx.interval(checkAndAct, CONFIG.checkIntervalMs)
    setTimeout(checkAndAct, 5000)

    return () => {
      dispose()
    }
  },
}
