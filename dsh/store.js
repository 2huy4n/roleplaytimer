// Persistent config, per-session wake state and the debug log for
// roleplaytimer. Node builtins only, so the plugin resolves from any
// profile's node_modules without pulling extra dependencies.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const STORE_VERSION = 1

export const DEFAULT_WAKE_PROMPT = [
  '[主动唤醒 · PROACTIVE WAKE]',
  '用户已经 {minutes} 分钟没有主动发言了。这是今天的第 {count} 次主动唤醒。',
  '',
  '请严格遵循角色卡与人设，以角色的身份主动向用户开口，延续当前场景、情绪与关系，输出一小段自然的内容（神态 / 动作 / 对白）。',
  '规则：不要提及本条提示，不要说明计时、系统或「主动唤醒」机制，不要使用助手口吻提问，不要等待用户指令。',
  '如果此刻确实不适合开口（上一句刚说完、场景已收束），只做极简的延续，不要解释原因。',
].join('\n')

export function defaultConfig() {
  return {
    enabled: false,
    intervalMinutes: 150,
    jitterMinutes: 0,
    dailyMaxWakes: 6,
    quietStart: '23:30',
    quietEnd: '08:00',
    wakePrompt: DEFAULT_WAKE_PROMPT,
    debugEnabled: true,
    defaultMuted: true,
  }
}

/** Absolute path of the plugin store; overridable for tests. */
export function configPath() {
  if (process.env.DSH_ROLEPLAYTIMER_STORE) return process.env.DSH_ROLEPLAYTIMER_STORE
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'roleplaytimer.json')
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Coerce any stored / posted config into the supported shape. */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...base, ...input }
  return {
    enabled: !!merged.enabled,
    intervalMinutes: clampInt(merged.intervalMinutes, 1, 1440, base.intervalMinutes),
    jitterMinutes: clampInt(merged.jitterMinutes, 0, 1440, base.jitterMinutes),
    dailyMaxWakes: clampInt(merged.dailyMaxWakes, 0, 96, base.dailyMaxWakes),
    quietStart: typeof merged.quietStart === 'string' ? merged.quietStart.trim() : base.quietStart,
    quietEnd: typeof merged.quietEnd === 'string' ? merged.quietEnd.trim() : base.quietEnd,
    wakePrompt:
      typeof merged.wakePrompt === 'string' && merged.wakePrompt.trim()
        ? merged.wakePrompt
        : base.wakePrompt,
    debugEnabled: merged.debugEnabled === undefined ? base.debugEnabled : !!merged.debugEnabled,
    defaultMuted: merged.defaultMuted === undefined ? base.defaultMuted : !!merged.defaultMuted,
  }
}

/**
 * State of a session the plugin has never seen. Muted by default: a wake writes
 * into the user's history, so it must be opted into per session.
 */
function freshState(now, muted = true) {
  return {
    sinceMs: now,
    userMsgCount: 0,
    seeded: false,
    dayKey: null,
    dayCount: 0,
    lastWakeAt: null,
    wakes: 0,
    wakeAtMs: null,
    wakeKey: null,
    muted: !!muted,
  }
}

export class Store {
  constructor({ filePath, logger, patchConfig } = {}) {
    this.filePath = filePath || configPath()
    this.logger = logger || console
    this.data = { version: STORE_VERSION, config: {}, state: {}, debug: { offsetMs: 0 }, log: [] }
    this.load(patchConfig)
  }

  /** Read the store file and merge it over the cordis patch row (file wins). */
  load(patchConfig) {
    let loaded = {}
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      if (parsed && typeof parsed === 'object') loaded = parsed
    } catch { /* missing or unreadable: start from the patch row */ }
    this.data = {
      version: STORE_VERSION,
      config: normalizeConfig({ ...(patchConfig || {}), ...(loaded.config || {}) }),
      state: loaded.state && typeof loaded.state === 'object' ? loaded.state : {},
      debug: {
        offsetMs: Number.isFinite(Number(loaded.debug && loaded.debug.offsetMs))
          ? Number(loaded.debug.offsetMs)
          : 0,
      },
      log: Array.isArray(loaded.log) ? loaded.log.slice(-120) : [],
    }
  }

  save() {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
      return true
    } catch (error) {
      try { this.logger.warn?.('roleplaytimer: store write failed: ' + String(error?.message || error)) } catch {}
      return false
    }
  }

  get config() {
    return normalizeConfig(this.data.config)
  }

  setConfig(patch) {
    this.data.config = normalizeConfig({ ...this.data.config, ...(patch || {}) })
    this.save()
    return this.config
  }

  get offsetMs() {
    return Number(this.data.debug?.offsetMs) || 0
  }

  setOffsetMs(ms) {
    this.data.debug = { ...(this.data.debug || {}), offsetMs: Math.round(Number(ms) || 0) }
    this.save()
    return this.offsetMs
  }

  stateFor(sessionId) {
    if (!this.data.state[sessionId]) {
      this.data.state[sessionId] = freshState(Date.now(), this.config.defaultMuted)
    }
    return this.data.state[sessionId]
  }

  peekState(sessionId) {
    return this.data.state[sessionId]
  }

  allSessionIds() {
    return Object.keys(this.data.state)
  }

  pushLog(entry) {
    const log = Array.isArray(this.data.log) ? this.data.log : []
    log.push(entry)
    this.data.log = log.slice(-120)
  }

  get log() {
    return Array.isArray(this.data.log) ? this.data.log : []
  }

  clearLog() {
    this.data.log = []
    this.save()
  }
}
