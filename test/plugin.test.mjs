import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Store } from '../dsh/store.js'
import { WakeRuntime, dayKeyOf, createWakeMessage, scanUserActivity, sessionTitleOf } from '../dsh/runtime.js'
import { apply } from '../dsh/index.js'

const quiet = { warn() {}, info() {}, error() {} }

function tempStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-'))
  return { dir, file: path.join(dir, 'roleplaytimer.json') }
}

function makeStore(file, patch = {}) {
  return new Store({
    filePath: file,
    logger: quiet,
    // Existing tests describe the opt-in path; the muted default is covered by
    // its own test below.
    patchConfig: { enabled: true, intervalMinutes: 5, dailyMaxWakes: 0, quietStart: '', quietEnd: '', defaultMuted: false, ...patch },
  })
}

/** Pre-seeded state: keeps a manually chosen sinceMs across the first tick. */
function seededState(store, sessionId) {
  const st = store.stateFor(sessionId)
  st.seeded = true
  return st
}

function makeAgent(sessionId, events = []) {
  const followups = []
  const agent = {
    id: 'agent-' + sessionId,
    session: { id: sessionId, snapshotEvents: () => events.slice() },
    followups,
    ctx: { effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} } },
    runMaintenance: (fn) => Promise.resolve(fn()),
    followup: (message) => { followups.push(message) },
  }
  return agent
}

function makeCtx(agents) {
  const routes = []
  const effects = []
  const listeners = new Map()
  const ctx = {
    logger: quiet,
    effect(fn) { const cleanup = fn(); effects.push(cleanup); return cleanup },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    agents: { roots: () => agents },
    inject(deps, fn) {
      if (deps.includes('webServer')) fn({ webServer: { register: (route) => routes.push(route) } })
    },
  }
  return { ctx, routes, effects, listeners }
}

function reqOf(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

function resOf() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(text) { this.body = text || '' },
    json() { return JSON.parse(this.body) },
  }
}

const today = () => dayKeyOf(Date.now())

test('fires a user-role follow-up once the silence window elapses', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-a')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-a')
    st.sinceMs = Date.now() - 10 * 60_000
    st.dayKey = today()

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 1)
    const message = agent.followups[0]
    // The session log stores this object verbatim as a user/message event and
    // the loader rejects it without an identity, so id/role are load-bearing.
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
    assert.equal(message.source.kind, 'plugin')
    assert.equal(message.source.plugin, 'roleplaytimer')
    assert.equal(message.content[0].type, 'text')
    assert.match(message.content[0].text, /\[主动唤醒 · PROACTIVE WAKE\]/)
    assert.match(message.content[0].text, /10 分钟没有主动发言/)

    assert.equal(st.dayCount, 1)
    assert.equal(st.wakes, 1)
    assert.ok(st.lastWakeAt !== null)
    assert.equal(store.log.length, 1)
    assert.equal(store.log[0].kind, 'wake')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stays silent while the window has not elapsed', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-b')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    seededState(store, 'session-b').sinceMs = Date.now() - 2 * 60_000

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 0)
    assert.equal(store.log.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new user message resets the silence window', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-c')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-c')
    st.sinceMs = Date.now() - 10 * 60_000
    st.userMsgCount = 0

    agent.session.snapshotEvents = () => [{ type: 'user/message', data: { source: { kind: 'user' } } }]
    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 0)
    assert.equal(st.userMsgCount, 1)
    assert.ok(Date.now() - st.sinceMs < 2000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('muted sessions never fire', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-d')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-d')
    st.sinceMs = Date.now() - 10 * 60_000
    st.muted = true

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a freshly seen session starts muted and stays silent', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file, { defaultMuted: true })
    const agent = makeAgent('session-m')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-m')
    st.sinceMs = Date.now() - 60 * 60_000

    await runtime.tick()
    await runtime.dispose()

    assert.equal(store.peekState('session-m').muted, true)
    assert.equal(agent.followups.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unmuting a session restores wake delivery', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file, { defaultMuted: true })
    const agent = makeAgent('session-n')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-n')
    st.sinceMs = Date.now() - 60 * 60_000

    runtime.setMuted(false)
    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disabled config keeps the runtime idle', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file, { enabled: false })
    const agent = makeAgent('session-e')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    seededState(store, 'session-e').sinceMs = Date.now() - 600 * 60_000

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fireNow bypasses the schedule for the debug button', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-f')
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    seededState(store, 'session-f').sinceMs = Date.now()

    await runtime.fireNow()
    await runtime.dispose()

    assert.equal(agent.followups.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a busy agent is retried instead of dropping the wake', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file)
    const agent = makeAgent('session-g')
    let followups = 0
    agent.runMaintenance = () => { throw new Error('busy') }
    agent.followup = () => { followups += 1 }
    const runtime = new WakeRuntime({ agent, store, logger: quiet })
    const st = seededState(store, 'session-g')
    st.sinceMs = Date.now() - 10 * 60_000

    await runtime.tick()
    await runtime.dispose()

    assert.equal(followups, 0)
    assert.equal(st.dayCount, 0)
    assert.equal(store.log.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply() attaches to live roots and exposes the three routes', async () => {
  const { dir, file } = tempStorePath()
  try {
    process.env.DSH_ROLEPLAYTIMER_STORE = file
    const agent = makeAgent('session-h')
    const { ctx, routes, listeners } = makeCtx([agent])
    apply(ctx, { enabled: false })

    assert.deepEqual(
      routes.map((r) => r.path).sort(),
      ['/roleplaytimer/config', '/roleplaytimer/debug', '/roleplaytimer/status'],
    )
    assert.equal(typeof listeners.get('agent/created'), 'function')

    const statusRoute = routes.find((r) => r.path.endsWith('/status'))
    const res = resOf()
    await statusRoute.handler(reqOf('GET'), res)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.agents.length, 1)
    assert.equal(body.agents[0].sessionId, 'session-h')
    assert.equal(body.config.enabled, false)
  } finally {
    delete process.env.DSH_ROLEPLAYTIMER_STORE
    rmSync(dir, { recursive: true, force: true })
  }
})

test('first sight adopts the last user timestamp from the log', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file, { intervalMinutes: 5 })
    const fiveHoursAgo = Date.now() - 5 * 60 * 60_000
    const agent = makeAgent('session-j', [
      { type: 'user/message', time: fiveHoursAgo, data: { source: { kind: 'user' } } },
    ])
    const runtime = new WakeRuntime({ agent, store, logger: quiet })

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 1)
    assert.equal(store.log.length, 1)
    assert.equal(store.log[0].minutes, 300)
    assert.match(agent.followups[0].content[0].text, /300 分钟没有主动发言/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a recent user turn keeps the runtime quiet', async () => {
  const { dir, file } = tempStorePath()
  try {
    const store = makeStore(file, { intervalMinutes: 5 })
    const agent = makeAgent('session-k', [
      { type: 'user/message', time: Date.now() - 60_000, data: { source: { kind: 'user' } } },
    ])
    const runtime = new WakeRuntime({ agent, store, logger: quiet })

    await runtime.tick()
    await runtime.dispose()

    assert.equal(agent.followups.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanUserActivity reports the last real user turn and skips plugin messages', () => {
  const activity = scanUserActivity({
    session: {
      snapshotEvents: () => [
        { type: 'user/message', time: 1000, data: { source: { kind: 'user' } } },
        { type: 'user/message', time: 9999, data: { source: { kind: 'plugin', plugin: 'roleplaytimer' } } },
        { type: 'user/message', time: 2000, data: { source: { kind: 'user' } } },
      ],
    },
  })
  assert.equal(activity.count, 2)
  assert.equal(activity.lastAt, 2000)
})

test('config route persists edits and the debug route moves the clock', async () => {
  const { dir, file } = tempStorePath()
  process.env.DSH_ROLEPLAYTIMER_STORE = file
  try {
    const agent = makeAgent('session-i')
    const { ctx, routes } = makeCtx([agent])
    apply(ctx, { enabled: false })

    const configRoute = routes.find((r) => r.path.endsWith('/config'))
    const debugRoute = routes.find((r) => r.path.endsWith('/debug'))

    const saved = resOf()
    await configRoute.handler(reqOf('POST', { config: { enabled: true, intervalMinutes: 42, dailyMaxWakes: 3 } }), saved)
    assert.equal(saved.json().value.intervalMinutes, 42)
    assert.equal(saved.json().value.dailyMaxWakes, 3)

    const reloaded = new Store({ filePath: file, logger: quiet })
    assert.equal(reloaded.config.intervalMinutes, 42)
    assert.equal(reloaded.config.enabled, true)

    const advanced = resOf()
    await debugRoute.handler(reqOf('POST', { action: 'advance', minutes: 90 }), advanced)
    assert.equal(advanced.json().offsetMs, 90 * 60_000)

    const reset = resOf()
    await debugRoute.handler(reqOf('POST', { action: 'clock-reset' }), reset)
    assert.equal(reset.json().offsetMs, 0)

    const bad = resOf()
    await debugRoute.handler(reqOf('POST', { action: 'nope' }), bad)
    assert.equal(bad.status, 400)
    assert.equal(bad.json().ok, false)
  } finally {
    delete process.env.DSH_ROLEPLAYTIMER_STORE
    rmSync(dir, { recursive: true, force: true })
  }
})
test('createWakeMessage mints the identity the session log requires', () => {
  const message = createWakeMessage('hi')
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'roleplaytimer' })
  assert.notEqual(createWakeMessage('hi').id, message.id)
})

test('sessionTitleOf prefers the sessionTitle service and falls back to the log', () => {
  const session = {
    id: 'session-t',
    snapshotEvents: () => [{ type: 'session/title', seq: 3, data: { title: '来自日志的标题' } }],
  }
  assert.equal(sessionTitleOf({ session }, { get: () => ({ get: () => ({ title: '服务的标题' }) }) }), '服务的标题')
  assert.equal(sessionTitleOf({ session }, {}), '来自日志的标题')
  assert.equal(sessionTitleOf({ session: { id: 'x', snapshotEvents: () => [] } }, {}), null)
})
