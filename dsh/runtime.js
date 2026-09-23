// Wake scheduling for one root agent: inactivity tracking, the timing
// decision and delivery into the agent's idle maintenance window.

import { randomUUID } from 'node:crypto'

export const MAX_TIMER_DELAY_MS = 5 * 60 * 1000
export const MIN_TIMER_DELAY_MS = 2 * 1000

export function sessionIdOf(agent) {
  const session = agent && agent.session
  const id = session && (session.id || (session.header && session.header.id))
  return id || (agent && agent.id) || 'unknown'
}

/**
 * Build one complete user-role message for agent.followup().
 *
 * The session log does NOT validate inbox input: whatever object is queued is
 * written verbatim as the data of a `user/message` event, which the loader
 * later requires to be an identified message (non-empty `id`, `role: "user"`).
 * A bare `{ content, source }` therefore persists an unrecoverable session, so
 * the identity has to be minted here.
 */
export function createWakeMessage(text, plugin = 'roleplaytimer') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text == null ? '' : text) }],
    source: { kind: 'plugin', plugin },
  }
}

/** Human-readable session title for the debug panel; null when unavailable. */
export function sessionTitleOf(agent, ctx) {
  const session = agent && agent.session
  if (!session) return null
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    const snapshot = service && typeof service.get === 'function' ? service.get(session) : undefined
    if (snapshot && typeof snapshot.title === 'string' && snapshot.title) return snapshot.title
  } catch { /* session-title service not mounted */ }
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    const event = Array.isArray(events)
      ? events.findLast((item) => item && item.type === 'session/title')
      : undefined
    const title = event && event.data && event.data.title
    if (typeof title === 'string' && title) return title
  } catch { /* no log access */ }
  return null
}

export function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function localMinutes(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** Parse 'HH:MM' into minutes-of-day; null when malformed. */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Quiet window in minutes-of-day, or null when unset / degenerate. */
export function quietWindow(cfg) {
  const start = parseClock(cfg && cfg.quietStart)
  const end = parseClock(cfg && cfg.quietEnd)
  if (start === null || end === null || start === end) return null
  return { start, end }
}

export function inQuietMinutes(minute, start, end) {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function msUntilQuietEnd(ms, end) {
  const delta = (end - localMinutes(ms) + 1440) % 1440
  return (delta === 0 ? 1440 : delta) * 60_000
}

function msUntilLocalMidnight(ms) {
  const d = new Date(ms)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0)
  return Math.max(1000, next.getTime() - ms)
}

export function clampDelay(ms) {
  if (!Number.isFinite(ms)) return MAX_TIMER_DELAY_MS
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TIMER_DELAY_MS, Math.round(ms)))
}

/**
 * Decide what the runtime should do next. Pure: the debug clock offset is
 * folded in here so 'simulate elapsed time' only changes the stored offset.
 */
export function decide({ nowMs, sinceMs, dayCount, cfg, offsetMs = 0 }) {
  if (!cfg || !cfg.enabled) return { kind: 'wait', delayMs: MAX_TIMER_DELAY_MS, reason: 'disabled' }

  const clock = nowMs + (Number(offsetMs) || 0)
  if (cfg.dailyMaxWakes > 0 && dayCount >= cfg.dailyMaxWakes) {
    return { kind: 'wait', delayMs: clampDelay(msUntilLocalMidnight(clock)), reason: 'daily-max' }
  }

  const intervalMs = Math.max(1, cfg.intervalMinutes) * 60_000
  const dueAt = sinceMs + intervalMs
  if (clock < dueAt) return { kind: 'wait', delayMs: clampDelay(dueAt - clock), reason: 'not-due' }

  const quiet = quietWindow(cfg)
  if (quiet && inQuietMinutes(localMinutes(clock), quiet.start, quiet.end)) {
    return { kind: 'wait', delayMs: clampDelay(msUntilQuietEnd(clock, quiet.end)), reason: 'quiet-hours' }
  }

  return { kind: 'fire', reason: 'silent', silentMs: clock - sinceMs }
}

/** Substitute {key} placeholders, leaving unknown keys untouched. */
export function renderPrompt(template, vars) {
  const values = vars && typeof vars === 'object' ? vars : {}
  return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}

/**
 * Read genuine user activity from the live session log: how many user turns
 * exist and when the last one happened. Plugin- and schedule-sourced
 * follow-ups never count as user activity.
 */
export function scanUserActivity(agent) {
  const session = agent && agent.session
  if (!session) return { count: 0, lastAt: null }
  let events
  try {
    if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (typeof session.ownEvents === 'function') events = session.ownEvents()
    else return { count: 0, lastAt: null }
  } catch {
    return { count: 0, lastAt: null }
  }
  if (!Array.isArray(events)) return { count: 0, lastAt: null }

  let strict = 0
  let strictLast = null
  let total = 0
  let totalLast = null
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const payload = event.data && typeof event.data === 'object' ? event.data : event
    const source = payload && payload.source
    const kind = source && typeof source === 'object' ? source.kind : undefined
    const at = Number.isFinite(event.time) ? event.time : null

    total += 1
    if (at !== null && (totalLast === null || at > totalLast)) totalLast = at
    if (kind === 'user') {
      strict += 1
      if (at !== null && (strictLast === null || at > strictLast)) strictLast = at
    }
  }
  // Older / seeded logs may omit the source: fall back rather than undercount.
  return strict > 0 ? { count: strict, lastAt: strictLast } : { count: total, lastAt: totalLast }
}

/** Count only, for callers that do not need the timestamp. */
export function scanUserMessages(agent) {
  return scanUserActivity(agent).count
}

export class WakeRuntime {
  constructor({ agent, store, logger }) {
    this.agent = agent
    this.store = store
    this.logger = logger || console
    this.sessionId = sessionIdOf(agent)
    this.timer = undefined
    this.disposed = false
    this.firing = false
  }

  start() {
    this.requestDrive(2000)
  }

  requestDrive(delayMs) {
    if (this.disposed || this.timer !== undefined) return
    const delay = Math.max(0, Number(delayMs) || 0)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delay)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async tick() {
    if (this.disposed) return
    let cfg
    let st
    try {
      cfg = this.store.config
      st = this.store.stateFor(this.sessionId)
      const today = dayKeyOf(Date.now() + this.store.offsetMs)
      if (st.dayKey !== today) {
        st.dayKey = today
        st.dayCount = 0
      }
      const activity = scanUserActivity(this.agent)
      if (!st.seeded) {
        // First sight of this session: trust the log's own timestamps, so a
        // silence that started before the plugin loaded still counts.
        st.seeded = true
        st.userMsgCount = activity.count
        st.sinceMs = activity.lastAt || Date.now()
        this.store.save()
      } else if (activity.lastAt !== null && activity.lastAt > st.sinceMs) {
        st.userMsgCount = activity.count
        st.sinceMs = activity.lastAt
        this.store.save()
      } else if (activity.count > st.userMsgCount) {
        st.userMsgCount = activity.count
        st.sinceMs = Date.now()
        this.store.save()
      } else if (activity.count < st.userMsgCount) {
        st.userMsgCount = activity.count
      }
    } catch (error) {
      this.logger.warn?.('roleplaytimer: tick failed: ' + String(error?.message || error))
      this.requestDrive(60_000)
      return
    }

    if (st.muted) {
      this.requestDrive(60_000)
      return
    }

    const decision = decide({
      nowMs: Date.now(),
      sinceMs: st.sinceMs,
      dayCount: st.dayCount,
      cfg,
      offsetMs: this.store.offsetMs,
    })

    if (decision.kind === 'wait') {
      this.requestDrive(decision.delayMs)
      return
    }

    const fired = await this.fire()
    this.requestDrive(fired ? 5000 : 30_000)
  }

  /** Deliver one wake message inside the agent's idle maintenance window. */
  async fire() {
    if (this.disposed || this.firing) return false
    this.firing = true
    try {
      const cfg = this.store.config
      const st = this.store.stateFor(this.sessionId)
      const now = Date.now()
      const silentMs = Math.max(0, now + this.store.offsetMs - st.sinceMs)
      const text = renderPrompt(cfg.wakePrompt, {
        minutes: Math.max(1, Math.round(silentMs / 60_000)),
        count: st.dayCount + 1,
        session_id: this.sessionId,
        time: new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      })

      let maintenance
      try {
        maintenance = this.agent.runMaintenance(() => {
          try {
            this.agent.followup(createWakeMessage(text))
          } catch (error) {
            this.logger.warn?.('roleplaytimer: followup failed: ' + String(error?.message || error))
            return Promise.resolve(false)
          }
          return Promise.resolve(true)
        })
      } catch {
        // runMaintenance throws synchronously while another activity owns idle.
        return false
      }

      let delivered = false
      try {
        delivered = await maintenance
      } catch (error) {
        this.logger.warn?.('roleplaytimer: maintenance failed: ' + String(error?.message || error))
        return false
      }
      if (!delivered) return false

      const at = Date.now()
      st.dayCount += 1
      st.wakes += 1
      st.lastWakeAt = at
      st.sinceMs = at
      st.userMsgCount = scanUserActivity(this.agent).count
      this.store.pushLog({
        ts: at,
        kind: 'wake',
        sessionId: this.sessionId,
        minutes: Math.max(1, Math.round(silentMs / 60_000)),
        text,
      })
      this.store.save()
      return true
    } finally {
      this.firing = false
    }
  }

  /** Debug: fire now, ignoring the schedule. */
  async fireNow() {
    const st = this.store.stateFor(this.sessionId)
    if (st.muted) return false
    return this.fire()
  }

  /** Debug: treat the user as active right now. */
  resetTimer() {
    const st = this.store.stateFor(this.sessionId)
    st.sinceMs = Date.now()
    st.userMsgCount = scanUserActivity(this.agent).count
    this.store.save()
    this.requestDrive(1000)
  }

  setMuted(muted) {
    const st = this.store.stateFor(this.sessionId)
    st.muted = !!muted
    this.store.save()
    this.requestDrive(1000)
  }

  async dispose() {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
