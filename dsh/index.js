// roleplaytimer host plugin.
//
// Wakes a live root agent after a configurable silence window by queueing a
// normal user-role follow-up message (the same seam dsh-schedule uses), so the
// model speaks first under its character card instead of waiting for input.
//
// Mounted through cordis.patch.yml (see package.json dsh.bundle). The web
// settings panel talks to the routes registered at the bottom of this file.

import { Store, configPath, defaultConfig } from './store.js'
import { WakeRuntime, sessionIdOf, sessionTitleOf, dayKeyOf } from './runtime.js'

export const name = 'roleplaytimer'
export const inject = ['agents']

const ROUTE = '/roleplaytimer'
const RETRY_AFTER_CONFIG_MS = 200

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const parsed = JSON.parse(raw || '{}')
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const store = new Store({ filePath: configPath(), logger, patchConfig: config })
  /** agent -> { runtime, cleanup } */
  const entries = new Map()
  let stopping = false

  const attach = (agent) => {
    if (stopping || !agent || entries.has(agent)) return
    // Never let a mismatched context break DSH boot: skip instead of throwing.
    if (!agent.ctx || typeof agent.ctx.effect !== 'function') {
      logger.warn?.('roleplaytimer: agent ' + String(agent.id) + ' has no scoped context; skipped')
      return
    }
    try {
      const runtime = new WakeRuntime({ agent, store, logger })
      const cleanup = agent.ctx.effect(() => {
        runtime.start()
        return async () => {
          try {
            await runtime.dispose()
          } finally {
            if (entries.get(agent)?.cleanup === cleanup) entries.delete(agent)
          }
        }
      }, 'roleplaytimer.runtime()')
      entries.set(agent, { runtime, cleanup })
    } catch (error) {
      logger.warn?.('roleplaytimer: attach failed: ' + String(error?.message || error))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const stopCreated =
        typeof ctx.on === 'function'
          ? ctx.on('agent/created', ({ agent }) => {
              try {
                if (ctx.agents?.roots && !ctx.agents.roots().includes(agent)) return
              } catch { /* roots() unavailable: attach anyway */ }
              attach(agent)
            })
          : () => {}
      // Pick up roots that were already live when this plugin loaded.
      try {
        for (const agent of ctx.agents?.roots?.() ?? []) {
          try { attach(agent) } catch (error) { logger.warn?.('roleplaytimer: ' + String(error?.message || error)) }
        }
      } catch { /* roots() unavailable */ }
      return async () => {
        stopping = true
        try { stopCreated() } catch { /* ignore */ }
        const cleanups = [...entries.values()].map((entry) => entry.cleanup)
        entries.clear()
        await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve(cleanup())))
      }
    }, 'roleplaytimer.lifecycle()')
  }

  const describeAgent = (agent) => {
    const sessionId = sessionIdOf(agent)
    const st = store.peekState(sessionId)
    const cfg = store.config
    const clock = Date.now() + store.offsetMs
    const sinceMs = st ? st.sinceMs : clock
    return {
      sessionId,
      title: sessionTitleOf(agent, ctx),
      agentId: agent.id,
      muted: !!(st && st.muted),
      sinceMs,
      silentMinutes: Math.max(0, Math.round((clock - sinceMs) / 60000)),
      nextWakeAt: sinceMs + cfg.intervalMinutes * 60000,
      dayCount: st ? st.dayCount : 0,
      dayKey: st ? st.dayKey : dayKeyOf(clock),
      lastWakeAt: st ? st.lastWakeAt : null,
      wakes: st ? st.wakes : 0,
    }
  }

  const status = () => ({
    ok: true,
    path: store.filePath,
    config: store.config,
    defaults: defaultConfig(),
    offsetMs: store.offsetMs,
    agents: [...entries.keys()].map(describeAgent),
    log: store.log.slice(-40).reverse(),
  })

  /** Run fn for every live runtime, optionally filtered to one session. */
  const forEachEntry = (sessionId, fn) => {
    let affected = 0
    for (const [agent, entry] of entries) {
      if (sessionId && sessionIdOf(agent) !== sessionId) continue
      fn(entry.runtime, agent)
      affected += 1
    }
    return affected
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/config',
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') {
                sendJson(res, 200, { ok: true, value: store.config, defaults: defaultConfig(), path: store.filePath })
                return
              }
              if (req.method === 'POST') {
                const body = await readJsonBody(req)
                const value = store.setConfig(body && typeof body.config === 'object' ? body.config : body)
                forEachEntry(null, (runtime) => runtime.requestDrive(RETRY_AFTER_CONFIG_MS))
                sendJson(res, 200, { ok: true, value })
                return
              }
              res.writeHead(405, { allow: 'GET, POST' })
              res.end()
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })

        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/status',
          handler: async (req, res) => {
            if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
            sendJson(res, 200, status())
          },
        })

        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/debug',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
            try {
              const body = await readJsonBody(req)
              const action = String(body.action || '')
              const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
              const minutes = Number(body.minutes)
              let affected = 0

              switch (action) {
                case 'advance': {
                  if (Number.isFinite(minutes) && minutes !== 0) {
                    store.setOffsetMs(store.offsetMs + minutes * 60000)
                  }
                  affected = forEachEntry(sessionId, (runtime) => runtime.requestDrive(RETRY_AFTER_CONFIG_MS))
                  break
                }
                case 'clock-reset': {
                  store.setOffsetMs(0)
                  affected = forEachEntry(sessionId, (runtime) => runtime.requestDrive(RETRY_AFTER_CONFIG_MS))
                  break
                }
                case 'fire': {
                  const targets = []
                  forEachEntry(sessionId, (runtime) => targets.push(runtime))
                  for (const runtime of targets) {
                    if (await runtime.fireNow()) affected += 1
                  }
                  break
                }
                case 'reset': {
                  affected = forEachEntry(sessionId, (runtime) => runtime.resetTimer())
                  break
                }
                case 'mute':
                case 'unmute': {
                  affected = forEachEntry(sessionId, (runtime) => runtime.setMuted(action === 'mute'))
                  break
                }
                case 'clear-log': {
                  store.clearLog()
                  break
                }
                case 'reload': {
                  store.load(config)
                  affected = forEachEntry(sessionId, (runtime) => runtime.requestDrive(RETRY_AFTER_CONFIG_MS))
                  break
                }
                default: {
                  sendJson(res, 400, { ok: false, error: 'unknown action: ' + action })
                  return
                }
              }

              sendJson(res, 200, { ...status(), affected, action })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })
      })
    } catch (error) {
      logger.warn?.('roleplaytimer: web routes unavailable: ' + String(error?.message || error))
    }
  }
}
