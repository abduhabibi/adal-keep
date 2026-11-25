// 2026-11-25: a Companion took the main role twice while Main was only restarting or off the Wi-Fi.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Roles, AUTO_AFTER, LEASE } from '../src/services/sync/roles.js'

const MIN = 60000
/** A PC's Roles over one shared little database (rows as every PC has them). */
function office(t0 = 1_800_000_000_000) {
  const o = { clock: t0, skew: 0, pcs: [], role: { holder: 'main', data: { how: 'first' } } }
  const iso = (ms) => new Date(ms).toISOString()
  o.pcs = [{ pc_id: 'main', name: 'Main', slot: 1, seen_at: iso(t0) }, { pc_id: 'comp', name: 'Comp', slot: 2, seen_at: iso(t0) }]
  o.make = (me, { skew = 0, net = async () => true } = {}) => {
    const n = { pcId: me, now: () => o.clock + skew, peerState: new Map(), log: { warn() {} }, netProof: net }
    const r = new Roles(n)
    r.refresh = async () => (r.cache = { main: { holder: o.role.holder, data: o.role.data } })
    r.pcs = async () => o.pcs.map(p => ({ ...p }))
    r.write = async (k, holder, data) => { o.role = { holder, data }; await r.refresh() }
    r.node = n
    return r
  }
  o.beat = (id, skew = 0) => { o.pcs.find(p => p.pc_id === id).seen_at = iso(o.clock + skew) }
  /** n minutes, one look each; a PC that beats does so every 3 minutes. → the first result that is not null */
  o.run = async (r, n, beats = []) => { for (let i = 0; i < n; i++) { o.clock += MIN; if (i % 3 === 0) for (const [id, sk] of beats) o.beat(id, sk); const x = await r.autoStep(); if (x) return x } return null }
  return o
}

test('a Companion just started with an old copy never takes the role at once', async () => {
  const o = office()
  o.clock += 9 * 3600e3                       // its copy is from yesterday evening
  const c = o.make('comp')
  assert.equal(await c.autoStep(), null)
  assert.equal(await o.run(c, AUTO_AFTER / MIN - 2), null, 'not before it looked long enough itself')
  assert.equal(await o.run(c, 4), 'taken')
  assert.equal(o.role.data.from, 'main')
})
test('as before (ADAL_ROLE_STEADY=0) it took it at once', async () => {
  process.env.ADAL_ROLE_STEADY = '0'
  try { const o = office(); o.clock += LEASE + MIN; o.beat('comp'); assert.equal(await o.make('comp').autoStep(), 'taken') } finally { delete process.env.ADAL_ROLE_STEADY }
})
test('Main off for a restart (20 minutes), or this PC asleep over it: nothing moves', async () => {
  const o = office(), c = o.make('comp')
  await c.autoStep()
  assert.equal(await o.run(c, 20), null)
  o.beat('main'); assert.equal(await o.run(c, 20), null)
  o.clock += 8 * 3600e3                       // the Companion slept
  assert.equal(await o.run(c, 20), null)
})
test('this PC reaches nobody (its own Wi-Fi is off): it never takes the role', async () => {
  const o = office(), c = o.make('comp', { net: async () => false })
  assert.equal(await o.run(c, 300), null)
  assert.equal(o.role.holder, 'main')
})
test('this PC\'s clock an hour wrong, either way: a Main that is seen keeps its role', async () => {
  for (const skew of [-3600e3, 3600e3]) {
    const o = office(), c = o.make('comp', { skew })
    assert.equal(await o.run(c, 120, [['main', 0]]), null, String(skew))
  }
})
test('Main back: handed back though the Companion\'s clock is an hour ahead (its take was "after" every heartbeat)', async () => {
  const o = office(), c = o.make('comp', { skew: 3600e3 })
  assert.equal(await o.run(c, 60), 'taken')
  c.node.peerState.set('main', { ok: true, seen: o.clock + 3600e3 })
  o.beat('main'); o.clock += MIN
  assert.equal(await c.autoStep(), 'handed-back')
  assert.equal(o.role.holder, 'main')
})
test('not handed back (the Companion does not reach it): Main takes its own role back after 10 minutes', async () => {
  const o = office()
  o.role = { holder: 'comp', data: { how: 'auto', from: 'main' } }
  const m = o.make('main')
  assert.equal(await o.run(m, 9, [['comp', 0]]), null)
  assert.equal(await o.run(m, 5, [['comp', 0]]), 'back')
  assert.equal(o.role.holder, 'main')
  // A role a person moved is not taken back.
  o.role = { holder: 'comp', data: { how: 'handed over', from: 'main' } }
  assert.equal(await o.run(m, 30, [['comp', 0]]), null)
})
