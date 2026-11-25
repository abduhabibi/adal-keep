// A Companion's window stays put on a slow main PC (frontend lib/steady.js; the program: adal-companion/steady_test.go).
import test from 'node:test'
import assert from 'node:assert/strict'
import { look, leaveStep, backStep, busyHere, _set } from '../../adal-keep-frontend/src/lib/steady.js'

test('a main PC that answers after 5 s and drops 20 % of the looks: the page never leaves', async () => {
  let x = 7
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647
  const s = {}
  let now = 0
  const ask = async () => { if (rnd() < 0.2) throw new TypeError('Failed to fetch'); return { status: 200 } }
  for (let i = 0; i < 8 * 3600 / 13; i++) { assert.equal(leaveStep(s, await look(ask, async () => {}), now), false); now += 13_000 }
  assert.equal(await look(async () => { throw new TypeError('refused') }, async () => {}), 'gone')
  assert.equal(await look(async () => { throw Object.assign(new Error('late'), { name: 'TimeoutError' }) }, async () => {}), 'slow')
  assert.equal(await look(async () => ({ status: 502 }), async () => {}), 'slow')
})
test('a restart of 30 s moves nothing; off for 45 s does; hung only after 5 minutes', () => {
  const s = {}
  for (let i = 0; i < 4; i++) assert.equal(leaveStep(s, 'gone', i * 10_000), false)
  assert.equal(leaveStep(s, 'up', 40_000), false)
  let left = null
  for (let i = 0; i < 10 && left == null; i++) if (leaveStep(s, 'gone', 50_000 + i * 8000)) left = i * 8000
  assert.ok(left >= 45_000 && left <= 56_000, String(left))
  const h = {}
  let at = null
  for (let t = 0; t < 900_000 && at == null; t += 16_000) if (leaveStep(h, 'slow', t)) at = t
  assert.ok(at >= 300_000 && at < 330_000, String(at))
})
test('back to the main PC: at once on a fresh start, steadily after it was left', () => {
  assert.equal(backStep({}, true, 0, false), true)
  const s = {}
  assert.equal(backStep(s, true, 0, true), false)
  assert.equal(backStep(s, false, 10_000, true), false)
  assert.equal(backStep(s, true, 20_000, true), false)
  assert.equal(backStep(s, true, 30_000, true), false)
  assert.equal(backStep(s, true, 40_000, true), true)
})
test('a save going on, or someone typing, holds it', () => {
  _set(1, 0); assert.equal(busyHere(1e9), true)
  _set(0, 1e9 - 5000); assert.equal(busyHere(1e9), true)
  _set(0, 1e9 - 30_000); assert.equal(busyHere(1e9), false)
})
