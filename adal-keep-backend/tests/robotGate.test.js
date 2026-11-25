/** robotGate.test.js — 2026-11-25: on a busy 2-core PC runs waited for ever. A run waiting for a person is not work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGate, averageLoad } from '../robots/gate.mjs'

test('the gate: never starved, one at a time while one works, said once', async () => {
  let t = 1000, hot = true, ours = 0
  const lines = []
  const gate = makeGate({ busy: async () => hot, working: () => ours, say: (m) => lines.push(m), maxWaitMs: 20000, now: () => t })
  hot = false; assert.equal(await gate(), true)
  // Busy with other programs, none of ours works: at most 20 s.
  hot = true
  for (let s = 0; s < 20; s += 4) { assert.equal(await gate(), false, `${s} s`); t += 4000 }
  assert.equal(await gate(), true, 'starts anyway')
  assert.equal(lines.length, 2, lines.join('\n'))
  // That run works now: the next one waits, however long, said once.
  ours = 1
  for (let i = 0; i < 50; i++) { t += 4000; assert.equal(await gate(), false) }
  assert.equal(lines.length, 3)
  // It waits for a person (not work): the next one starts.
  ours = 0
  assert.equal(await gate(), true)
  hot = false; ours = 1
  assert.equal(await gate(), true, 'a free processor: no waiting')
  process.env.ADAL_ROBOTS_GATE = '0'; hot = true
  assert.equal(await gate(), true, 'off')
  delete process.env.ADAL_ROBOTS_GATE
})

test('busy = the average of 15 s: a second at 100 % is not busy; a run a person pressed does not wait', async () => {
  let t = 0, all = 0, idle = 0
  const load = averageLoad({ times: () => ({ all, idle }), now: () => t, timer: false })
  const flips = []
  for (let i = 0; i < 40; i++) { t += 2500; all += 5000; idle += i % 4 ? 4900 : 0; load.take(); flips.push(load.over(0.8)) }   // one look in four at 100 %
  assert.equal(flips.includes(true), false, 'about 27 % on average')
  for (let i = 0; i < 8; i++) { t += 2500; all += 5000; load.take() }
  assert.equal(load.over(0.8), true, 'full for 20 s: busy')
  const lines = []
  const gate = makeGate({ busy: async () => true, working: () => 1, pressed: async () => true, say: (m) => lines.push(m), now: () => t })
  assert.equal(await gate(), true); assert.equal(lines.length, 0)
})
