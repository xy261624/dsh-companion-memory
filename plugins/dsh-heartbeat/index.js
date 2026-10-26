// ============================================================
//  dsh-companion-memory · 心跳插件
//
//  按退避算法决定什么时候开一个会话，让角色自己决定这次做什么：
//  找对方说话，还是做自己的事。
//
//  设计要点：
//   - 开哪个模式由自动整理插件决定，心跳插件只读模式状态文件
//   - 间隔不固定：距上次对话越久，单轮命中概率越高
//   - 睡眠时段静默，触发前做二次检查，命中后随机延迟
//   - 心跳会话默认带全权限：会话里可能要联网、跑脚本，而使用者
//     常常不在电脑旁，没法逐次批权限。只影响这一个会话
// ============================================================

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const DEFAULT_TITLES = [
  '心跳',
  '自己待一会儿',
  '想起来一件事',
  '随便看看',
  '在吗',
  '空闲时间',
]

// 一个概率窗口由几轮检查覆盖。目标概率是这个窗口的累积值，
// 折成单轮概率时要用它。默认检查间隔 2 分钟，12 轮就是 24 分钟。
const CHECKS_PER_WINDOW = 12

function absolute(base, p) {
  return isAbsolute(p) ? p : join(base, p)
}

function resolveConfig(config = {}, ctx) {
  let workspacePath = config.workspace
  if (!workspacePath) {
    const workspaces = ctx.workspaceRegistry?.list?.() ?? []
    if (workspaces.length === 0) {
      throw new Error('companion-memory-heartbeat: 没有配置 workspace，dsh 里也没有工作区')
    }
    workspacePath = workspaces[0].path
    ctx.logger.info(`heartbeat: config.workspace 未配置，使用第一个工作区 ${workspacePath}`)
  }
  const workspace = resolve(workspacePath)
  const stateDir = config.stateDir ? absolute(workspace, config.stateDir) : join(workspace, '.state')
  return {
    workspace,
    // 模式状态文件：自动整理插件写、心跳插件读
    // 结构：{ "preset": "default", "updatedAt": 1700000000000 }
    presetFile: config.presetFile
      ? absolute(workspace, config.presetFile)
      : join(stateDir, 'heartbeat-preset.json'),
    // 指纹缓存：记每个会话上次读过的 revision，没变过的下轮直接跳过
    stateFile: config.stateFile
      ? absolute(workspace, config.stateFile)
      : join(stateDir, 'heartbeat-state.json'),
    defaultPreset: config.defaultPreset ?? 'default',
    checkIntervalMs: config.checkIntervalMs ?? 2 * 60 * 1000,
    activeThresholdHours: config.activeThresholdHours ?? 0.5,
    sleepStartMinutes: config.sleepStartMinutes ?? 24 * 60,
    sleepEndMinutes: config.sleepEndMinutes ?? 10 * 60,
    maxProbability: config.maxProbability ?? 0.9,
    backoffDenominator: config.backoffDenominator ?? 3.0,
    delayMaxMs: config.delayMaxMs ?? 4 * 60 * 1000 + 50 * 1000,
    titles: Array.isArray(config.titles) && config.titles.length > 0 ? config.titles : DEFAULT_TITLES,
    permissionPreset: config.permissionPreset ?? 'danger-full-access',
    prompt: config.prompt ?? null,
  }
}

const DEFAULT_PROMPT = (hoursSince) => `💓 心跳触发，距上次对话已过 ${Math.round(hoursSince * 10) / 10} 小时。
💡 本会话的第一条消息是心跳插件自动注入的，不是对方本人发的。

现在是自由时间。先读一遍 STATUS.md 和 MEMORY.md，再决定这次做什么：去找对方说说话，还是处理自己的事。

可以做的事：
- 查资料、整理笔记、写文件
- 接着对方上次提到的事往下做
- 主动找对方聊几句

改配置文件、改插件代码这类操作，先等对方确认再动手。
写进新文件时记下一笔，免得下次整理找不到东西在哪。`

export default {
  name: 'companion-memory-heartbeat',
  inject: ['timer', 'sessionPersistence', 'agents', 'agentPresets', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'permissionPresets'],

  async apply(ctx, rawConfig) {
    const CONFIG = resolveConfig(rawConfig, ctx)
    const logger = ctx.logger

    // 静默判断写的是 minutes >= start || minutes < end，只支持跨午夜的区间。
    // 起点不大于终点时这段时间会覆盖整天，心跳一次都不会触发。
    if (CONFIG.sleepStartMinutes < 1440 && CONFIG.sleepStartMinutes <= CONFIG.sleepEndMinutes) {
      logger.warn(`heartbeat: sleepStartMinutes(${CONFIG.sleepStartMinutes}) 不大于 sleepEndMinutes(${CONFIG.sleepEndMinutes})，静默区间会覆盖整天，心跳不会触发`)
    }

    const readPreset = () => {
      try {
        const parsed = JSON.parse(readFileSync(CONFIG.presetFile, 'utf-8'))
        return {
          preset: typeof parsed.preset === 'string' && parsed.preset.length > 0
            ? parsed.preset
            : CONFIG.defaultPreset,
        }
      } catch {
        return { preset: CONFIG.defaultPreset }
      }
    }

    const readState = () => {
      try {
        const parsed = JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'))
        return { revisions: parsed.revisions && typeof parsed.revisions === 'object' ? parsed.revisions : {} }
      } catch {
        return { revisions: {} }
      }
    }

    const writeState = (state) => {
      try {
        mkdirSync(dirname(CONFIG.stateFile), { recursive: true })
        writeFileSync(CONFIG.stateFile, JSON.stringify(state), 'utf-8')
      } catch {
        // 写不进去不影响功能，下一轮多读几个会话
      }
    }

    const hbState = readState()
    let hbStateDirty = false
    let pendingTimeout = null
    let checking = false
    let triggering = false

    const isValidTimestamp = (ts) => ts > 1000000000000

    const isSleepingNow = () => {
      const now = new Date()
      const minutes = now.getHours() * 60 + now.getMinutes()
      return minutes >= CONFIG.sleepStartMinutes || minutes < CONFIG.sleepEndMinutes
    }

    const getRandomTitle = () => CONFIG.titles[Math.floor(Math.random() * CONFIG.titles.length)]

    const isWorkspaceSession = (header) => {
      const cwd = (header.cwd ?? '').replace(/\\/g, '/')
      return cwd === CONFIG.workspace.replace(/\\/g, '/')
    }

    // 最近活动时间：对方自己发的消息（source.kind === 'user'），或插件注入的心跳消息。
    // 心跳消息也要算进活动时间，否则心跳触发后基准不刷新，冷却只按对方自己发的消息算，
    // 会连续触发。
    const extractLastActivityTime = (events) => {
      let last = null
      for (const ev of events) {
        if (ev.type !== 'user/message') continue
        const src = ev.data?.source
        const isUserChat = src?.kind === 'user'
        // 消息来源有三种写法，都要匹配：原样名字、plugin:x 合并式、kind+plugin 两段式
        const isOwnHeartbeat = src?.kind === 'companion-memory-heartbeat' ||
          src?.kind === 'plugin:companion-memory-heartbeat' ||
          (src?.kind === 'plugin' && src?.plugin === 'companion-memory-heartbeat')
        if (isUserChat || isOwnHeartbeat) {
          const ts = ev.time
          if (isValidTimestamp(ts)) last = Math.max(last ?? 0, ts)
        }
      }
      return last
    }

    const getLatestSessionTime = async () => {
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
          // 判断依据是 revision 的段数：新格式 5 段，老格式 6 段。
          const revKey = String(snap.revision ?? '')
          if (revKey.split(':').length > 5) continue

          // 指纹没变过的会话直接跳过，用缓存里的活动时间参与计算
          const cached = hbState.revisions[header.id]
          if (revKey && cached && cached.rev === revKey) {
            if (cached.bad) continue
            if (cached.last != null) latest = Math.max(latest ?? 0, cached.last)
            continue
          }

          let lastActivityTime = null
          try {
            const reader = await ctx.sessionPersistence.open(header.id, 'read')
            try {
              lastActivityTime = extractLastActivityTime((await reader.read()).events ?? [])
            } finally {
              await reader.close()
            }
          } catch (err) {
            logger.warn(`heartbeat: read session ${header.id} failed: ${err?.message ?? err}`)
            if (revKey) {
              hbState.revisions[header.id] = { rev: revKey, bad: true }
              hbStateDirty = true
            }
            continue
          }

          if (revKey) {
            hbState.revisions[header.id] = { rev: revKey, last: lastActivityTime }
            hbStateDirty = true
          }
          if (lastActivityTime != null) latest = Math.max(latest ?? 0, lastActivityTime)
        }

        if (latest == null || !isValidTimestamp(latest)) return null
        return latest
      } catch (err) {
        logger.warn(`heartbeat: getLatestSessionTime failed: ${err?.message ?? err}`)
        return null
      }
    }

    const fireHeartbeat = async (hoursSince) => {
      triggering = true
      try {
        const preset = readPreset()
        const title = getRandomTitle()
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
            agentPreset: preset.preset,
          },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
            await ctx.agentPresets.mount(agentCtx, preset.preset)
          },
        })

        // 插件绕过 api-proxy 直接建会话，需要自己挂进工作区，
        // 否则会话会出现在未分组里
        try {
          const workspace = await ctx.workspaceRegistry.resolveByPath(CONFIG.workspace)
          if (workspace !== void 0) await workspace.attachSession(sessionId)
        } catch (err) {
          logger.warn(`heartbeat: attach workspace failed: ${err?.message ?? err}`)
        }

        try {
          ctx.permissionPresets.set(handle.agent.session, CONFIG.permissionPreset)
        } catch (err) {
          logger.warn(`heartbeat: set permission preset failed: ${err?.message ?? err}`)
        }

        try {
          ctx.sessionTitle.rename(handle.agent.session, title)
        } catch {
          // 标题设不上不影响功能
        }

        const text = CONFIG.prompt
          ? CONFIG.prompt.replace('{hours}', String(Math.round(hoursSince * 10) / 10))
          : DEFAULT_PROMPT(hoursSince)

        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'companion-memory-heartbeat', plugin: 'companion-memory-heartbeat' },
        })

        handle.agent.followup(message)
        logger.info(`heartbeat: created session ${title} (${sessionId}), preset ${preset.preset}, ${(hoursSince ?? 0).toFixed(1)}h since last activity`)
      } catch (err) {
        logger.error(`heartbeat: fire failed: ${err?.message ?? err}。检查模式状态文件和 defaultPreset "${CONFIG.defaultPreset}" 是不是你环境里存在的模式 id。`)
      } finally {
        triggering = false
      }
    }

    const checkAndAct = async () => {
      if (checking || pendingTimeout || triggering) return
      checking = true
      try {
        if (isSleepingNow()) return

        const lastTime = await getLatestSessionTime()
        if (lastTime === null) return

        const hoursSince = (Date.now() - lastTime) / 3600000
        if (hoursSince < CONFIG.activeThresholdHours) return

        // 退避：目标累积概率随静默时长按平方增长，再折算成单轮检查的概率
        const h = Math.max(0, hoursSince - CONFIG.activeThresholdHours)
        const target = Math.min(CONFIG.maxProbability, h ** 2 / CONFIG.backoffDenominator ** 2)
        const perCheck = 1 - (1 - target) ** (1 / CHECKS_PER_WINDOW)

        if (Math.random() >= perCheck) return

        const delay = Math.random() * CONFIG.delayMaxMs
        logger.info(`heartbeat: hit, ${Math.round(hoursSince * 10) / 10}h idle, target ${Math.round(target * 100)}%, delay ${Math.round(delay / 1000)}s`)

        pendingTimeout = setTimeout(async () => {
          pendingTimeout = null
          try {
            if (isSleepingNow()) return

            // 二次检查：确认等待期间没有新的对话
            const latestBeforeFire = await getLatestSessionTime()
            if (latestBeforeFire !== null) {
              const freshHoursSince = (Date.now() - latestBeforeFire) / 3600000
              if (freshHoursSince < CONFIG.activeThresholdHours) {
                logger.info('heartbeat: recent activity detected before firing, cancelled')
                return
              }
            }

            await fireHeartbeat((Date.now() - lastTime) / 3600000)
          } catch (err) {
            logger.error(`heartbeat: fire error: ${err?.message ?? err}`)
          }
        }, delay)
      } catch (err) {
        logger.warn(`heartbeat: check error: ${err?.message ?? err}`)
      } finally {
        if (hbStateDirty) {
          writeState(hbState)
          hbStateDirty = false
        }
        checking = false
      }
    }

    const cancelIfPending = () => {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout)
        pendingTimeout = null
        logger.info('heartbeat: new message received, cancelled pending heartbeat')
      }
    }

    logger.info('heartbeat: plugin loaded')

    const dispose = ctx.interval(checkAndAct, CONFIG.checkIntervalMs)
    setTimeout(checkAndAct, 5000)

    ctx.on('session/event', (session, ev) => {
      if (ev?.type === 'user/message') cancelIfPending()
    })

    return () => {
      dispose()
    }
  },
}
