// A Companion's copy must never swamp the main PC (2026-11-22), and no PC is ever suspended by itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const { withSlot, _queueLength } = await import('../src/services/replicaThrottle.js')
const quick = { restMs: 1, busyRestMs: 1, load: async () => 10 }

test('one transfer at a time, in order', async () => {
  const log = []
  const job = (n, ms) => withSlot(async () => { log.push(`start ${n}`); await new Promise(r => setTimeout(r, ms)); log.push(`end ${n}`); return n }, quick)
  const out = await Promise.all([job(1, 40), job(2, 10), job(3, 10)])
  assert.deepEqual(out, [1, 2, 3])
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  assert.equal(_queueLength(), 0)
})

test('while the PC is busy a transfer waits for it, then goes ahead (never for ever)', async () => {
  let asks = 0
  const t0 = Date.now()
  const out = await withSlot(async () => 'done', { restMs: 1, busyRestMs: 1, waitBusyMs: 4000, load: async () => { asks++; return asks < 3 ? 95 : 20 } })
  assert.equal(out, 'done'); assert.ok(asks >= 3); assert.ok(Date.now() - t0 >= 3900 && Date.now() - t0 < 8000)
  const t1 = Date.now()
  assert.equal(await withSlot(async () => 'slow', { restMs: 1, busyRestMs: 1, waitBusyMs: 2000, load: async () => 99 }), 'slow')
  assert.ok(Date.now() - t1 < 6000)
})

test('a queue that does not move answers 503 with a retry time', async () => {
  const hold = withSlot(() => new Promise(r => setTimeout(() => r('held'), 400)), quick)
  await assert.rejects(withSlot(async () => 'never', { ...quick, queueMs: 100 }), (e) => e.status === 503 && e.retryAfter === 5)
  assert.equal(await hold, 'held')
  assert.equal(_queueLength(), 0)
  assert.equal(await withSlot(async () => 'free again', quick), 'free again')
})

test('nothing suspends a computer by itself: setSuspended is called only by the explicit route', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const hits = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name) && /setSuspended\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p).split(path.sep).join('/')) } }
  walk(root)
  assert.deepEqual(hits.sort(), ['routes/pcAccess.js', 'services/networkGate.js'])
  const route = fs.readFileSync(path.join(root, 'routes/pcAccess.js'), 'utf8')
  assert.match(route, /router\.post\('\/pc-access\/devices\/suspend', here,/, 'only on the main PC itself')
})
