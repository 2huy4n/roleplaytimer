import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clampDelay,
  dayKeyOf,
  decide,
  inQuietMinutes,
  MAX_TIMER_DELAY_MS,
  MIN_TIMER_DELAY_MS,
  parseClock,
  quietWindow,
  renderPrompt,
  rollWakeAt,
  scanUserMessages,
  wakeKeyOf,
} from '../dsh/runtime.js'
import { defaultConfig, normalizeConfig } from '../dsh/store.js'

const at = (h, m) => new Date(2026, 8, 23, h, m, 0, 0).getTime()

const cfg = (patch = {}) => normalizeConfig({ ...defaultConfig(), enabled: true, intervalMinutes: 150, ...patch })

const dueSince = (nowMs, extraMinutes = 200) => nowMs - extraMinutes * 60_000

test('disabled config never fires', () => {
  const now = at(14, 0)
  const d = decide({ nowMs: now, sinceMs: dueSince(now), dayCount: 0, cfg: cfg({ enabled: false }) })
  assert.equal(d.kind, 'wait')
  assert.equal(d.reason, 'disabled')
})

test('not due yet waits until the silence window elapses', () => {
  const now = at(14, 0)
  const d = decide({ nowMs: now, sinceMs: now - 30 * 60_000, dayCount: 0, cfg: cfg() })
  assert.equal(d.kind, 'wait')
  assert.equal(d.reason, 'not-due')
  // Long waits are split into bounded timer segments; the clock is re-read each time.
  assert.equal(d.delayMs, MAX_TIMER_DELAY_MS)
})

test('fires once the silence window elapses', () => {
  const now = at(14, 0)
  const d = decide({ nowMs: now, sinceMs: dueSince(now), dayCount: 0, cfg: cfg() })
  assert.equal(d.kind, 'fire')
  assert.equal(d.reason, 'silent')
  assert.equal(d.silentMs, 200 * 60_000)
})

test('daily cap defers to the next local midnight', () => {
  const now = at(14, 0)
  const d = decide({ nowMs: now, sinceMs: dueSince(now), dayCount: 6, cfg: cfg({ dailyMaxWakes: 6 }) })
  assert.equal(d.kind, 'wait')
  assert.equal(d.reason, 'daily-max')
  assert.equal(d.delayMs, MAX_TIMER_DELAY_MS)
})

test('dailyMaxWakes 0 means unlimited', () => {
  const now = at(14, 0)
  const d = decide({ nowMs: now, sinceMs: dueSince(now), dayCount: 99, cfg: cfg({ dailyMaxWakes: 0 }) })
  assert.equal(d.kind, 'fire')
})

test('quiet hours defer a due wake, including across midnight', () => {
  const late = at(23, 45)
  const d1 = decide({ nowMs: late, sinceMs: dueSince(late), dayCount: 0, cfg: cfg() })
  assert.equal(d1.reason, 'quiet-hours')

  const early = at(7, 0)
  const d2 = decide({ nowMs: early, sinceMs: dueSince(early), dayCount: 0, cfg: cfg() })
  assert.equal(d2.reason, 'quiet-hours')

  const awake = at(9, 0)
  const d3 = decide({ nowMs: awake, sinceMs: dueSince(awake), dayCount: 0, cfg: cfg() })
  assert.equal(d3.kind, 'fire')
})

test('quiet hours do not preempt a not-yet-due wake', () => {
  const late = at(23, 45)
  const d = decide({ nowMs: late, sinceMs: late - 10 * 60_000, dayCount: 0, cfg: cfg() })
  assert.equal(d.reason, 'not-due')
})

test('debug clock offset advances the decision clock', () => {
  const now = at(14, 0)
  const since = now - 100 * 60_000
  assert.equal(decide({ nowMs: now, sinceMs: since, dayCount: 0, cfg: cfg() }).reason, 'not-due')
  assert.equal(decide({ nowMs: now, sinceMs: since, dayCount: 0, cfg: cfg(), offsetMs: 60 * 60_000 }).kind, 'fire')
})

test('delays stay inside the timer segment bounds', () => {
  assert.equal(clampDelay(10), MIN_TIMER_DELAY_MS)
  assert.equal(clampDelay(10 * 60 * 60_000), MAX_TIMER_DELAY_MS)
  assert.equal(clampDelay(Number.NaN), MAX_TIMER_DELAY_MS)
})

test('parseClock accepts HH:MM and rejects junk', () => {
  assert.equal(parseClock('23:30'), 1410)
  assert.equal(parseClock('8:05'), 485)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('9:70'), null)
  assert.equal(parseClock(''), null)
  assert.equal(parseClock(undefined), null)
})

test('quietWindow ignores unset and degenerate windows', () => {
  assert.equal(quietWindow({ quietStart: '', quietEnd: '' }), null)
  assert.equal(quietWindow({ quietStart: '08:00', quietEnd: '08:00' }), null)
  assert.deepEqual(quietWindow({ quietStart: '23:30', quietEnd: '08:00' }), { start: 1410, end: 480 })
})

test('inQuietMinutes handles both window shapes', () => {
  assert.equal(inQuietMinutes(1415, 1410, 480), true)
  assert.equal(inQuietMinutes(60, 1410, 480), true)
  assert.equal(inQuietMinutes(600, 1410, 480), false)
  assert.equal(inQuietMinutes(600, 540, 720), true)
  assert.equal(inQuietMinutes(800, 540, 720), false)
})

test('renderPrompt substitutes known keys only', () => {
  assert.equal(renderPrompt('{minutes}m #{count} {unknown}', { minutes: 150, count: 3 }), '150m #3 {unknown}')
  assert.equal(renderPrompt('plain', {}), 'plain')
})

test('dayKeyOf is a local calendar key', () => {
  assert.equal(dayKeyOf(at(0, 5)), '2026-09-23')
})

test('scanUserMessages counts real user turns and ignores plugin follow-ups', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'roleplaytimer' } } },
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]
  assert.equal(scanUserMessages({ session: { snapshotEvents: () => events } }), 2)
})

test('scanUserMessages falls back when the log has no source metadata', () => {
  const events = [{ type: 'user/message', data: {} }, { type: 'user/message', data: {} }]
  assert.equal(scanUserMessages({ session: { snapshotEvents: () => events } }), 2)
})

test('scanUserMessages survives a missing or broken session', () => {
  assert.equal(scanUserMessages(undefined), 0)
  assert.equal(scanUserMessages({}), 0)
  assert.equal(
    scanUserMessages({
      session: {
        snapshotEvents: () => {
          throw new Error('boom')
        },
      },
    }),
    0,
  )
})

test('normalizeConfig clamps and keeps the supported shape', () => {
  const c = normalizeConfig({ intervalMinutes: 99999, dailyMaxWakes: -3, quietStart: ' 09:00 ', wakePrompt: '  ' })
  assert.equal(c.intervalMinutes, 1440)
  assert.equal(c.dailyMaxWakes, 0)
  assert.equal(c.quietStart, '09:00')
  assert.equal(c.wakePrompt, defaultConfig().wakePrompt)
  assert.equal(c.enabled, false)
  assert.equal(c.defaultMuted, true)
  assert.equal(normalizeConfig({ defaultMuted: false }).defaultMuted, false)
  assert.equal(c.jitterMinutes, 0)
  assert.equal(normalizeConfig({ jitterMinutes: 9999 }).jitterMinutes, 1440)
  assert.equal(normalizeConfig({ jitterMinutes: -5 }).jitterMinutes, 0)
})

test('rollWakeAt spreads the target inside interval ± jitter', () => {
  const roll = (random, jitterMinutes = 20) =>
    rollWakeAt({ sinceMs: 0, intervalMinutes: 60, jitterMinutes, random })
  assert.equal(roll(() => 0.5), 60 * 60_000)
  assert.equal(roll(() => 0), 40 * 60_000)
  assert.ok(roll(() => 0.9999999) <= 80 * 60_000)
  assert.equal(roll(() => 0, 0), 60 * 60_000)
  assert.equal(rollWakeAt({ sinceMs: 0, intervalMinutes: 1, jitterMinutes: 999, random: () => 0 }), 60_000)
})

test('wakeKeyOf tracks the inputs a target was rolled from', () => {
  const base = { intervalMinutes: 60, jitterMinutes: 20 }
  assert.notEqual(wakeKeyOf(1, base), wakeKeyOf(2, base))
  assert.notEqual(wakeKeyOf(1, base), wakeKeyOf(1, { ...base, jitterMinutes: 21 }))
  assert.equal(wakeKeyOf(1, base), wakeKeyOf(1, { ...base }))
})

test('decide honours an explicit rolled target', () => {
  const config = cfg({ dailyMaxWakes: 0, quietStart: '', quietEnd: '' })
  assert.equal(decide({ nowMs: 1000, sinceMs: 0, wakeAtMs: 500, dayCount: 0, cfg: config }).kind, 'fire')
  const late = decide({ nowMs: 1000, sinceMs: 0, wakeAtMs: 5_000_000, dayCount: 0, cfg: config })
  assert.equal(late.kind, 'wait')
  assert.equal(late.reason, 'not-due')
})
