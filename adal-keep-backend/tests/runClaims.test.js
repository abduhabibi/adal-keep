/**
 * runClaims.test.js — robots on every PC, one run per girl and site (the owner, 2026-11-27).
 * Three PCs in one process (one module copy each), a pretend office network that can be cut,
 * a pretend online copy with its own server clock, PC clocks that disagree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'

const SLOT = { 'pc-a': 1, 'pc-b': 2, 'pc-c': 3 }
let serverMs = 1_000_000
const net = { cut: new Set(), down: false }                     // cut: "pc-a|pc-b" pairs; down: no online copy
const linkCut = (x, y) => net.cut.has([x, y].sort().join('|'))
const online = new Map()                                         // path → { at }
const store = {
  async put(p) { if (net.down) throw new Error('offline'); serverMs += 10; online.set(p, { at: serverMs }); return true },
  async list(prefix) { if (net.down) throw new Error('offline'); return [...online].filter(([p]) => p.startsWith(prefix + '/')).map(([p, v]) => ({ name: p.slice(prefix.length + 1), at: v.at })) },
  async remove() {},
}
const pcs = {}
async function makePc(id, skew = 0) {
  const R = await import(`../src/services/runClaims.js?pc=${id}`)
  const clock = { add: 0 }
  const peerState = new Map()
  const node = {
    peerState,
    async others() { return Object.keys(SLOT).filter(x => x !== id && pcs[x]).map(x => ({ pc_id: x, name: x.toUpperCase(), slot: SLOT[x] })) },
    async reach(pc) { return linkCut(id, pc.pc_id) || pcs[pc.pc_id].off ? null : `lan://${pc.pc_id}` },
    async call(url, method, p, body) {
      const to = url.replace('lan://', '')
      if (linkCut(id, to) || pcs[to].off) throw new Error('not on the network')
      peerState.set(to, { ok: true, url, seen: Date.now() + clock.add })
      return pcs[to].R.peerClaim(body, { pc_id: id, name: id.toUpperCase() })
    },
  }
  R._setEnvForTests({ me: { pc_id: id, pc_name: id.toUpperCase() }, node, store, slot: () => SLOT[id], isMain: () => id === 'pc-a', now: () => Date.now() + skew + clock.add })
  pcs[id] = { R, node, clock, off: false }
  return pcs[id]
}
const job = (id, profile = 7, wf = 'musaned_contract') => ({ id, profile_id: profile, workflow_id: wf })
const idOn = (pc, n = 1) => (1_700_000_000_000 + n) * 1000 + SLOT[pc]

test.beforeEach(async () => { net.cut.clear(); net.down = false; online.clear(); for (const k of Object.keys(pcs)) delete pcs[k]; await makePc('pc-a'); await makePc('pc-b', 7 * 60_000); await makePc('pc-c', -3 * 60_000) })

test('the key is the site and the girl', async () => {
  const { R } = pcs['pc-a']
  assert.equal(R.keyOf(job(1, 7, 'musaned_contract')), 'musaned|7')
  assert.equal(R.keyOf(job(1, 7, 'musaned_visa_check')), 'musaned|7', 'two Musaned runs of one girl: one key')
  assert.equal(R.keyOf(job(1, 7, 'lmis_register')), 'lmis|7'); assert.equal(R.keyOf(job(1, 7, 'police_clearance')), 'lmis|7')
  assert.equal(R.queuedHere({ id: idOn('pc-b') }, 2), true); assert.equal(R.queuedHere({ id: idOn('pc-b') }, 1), false)
})

test('office network: one PC has it, the others are told who', async () => {
  const a = pcs['pc-a'], b = pcs['pc-b'], c = pcs['pc-c']
  assert.deepEqual(await a.R.claimRun(null, job(idOn('pc-a'))), { ok: true, via: 'lan' })
  const nb = await b.R.claimRun(null, job(idOn('pc-a')))
  assert.equal(nb.ok, false); assert.equal(nb.by, 'PC-A')
  assert.equal((await c.R.claimRun(null, job(idOn('pc-c', 2), 7, 'musaned_other'))).ok, false, 'same girl, same site, another run: no')
  assert.equal((await c.R.claimRun(null, job(idOn('pc-c', 3), 7, 'lmis_register'))).ok, true, 'same girl, another site: yes')
  assert.equal(b.R.runClaimsNow().find(l => l.key === 'musaned|7').pc_name, 'PC-A', 'every PC sees which PC does it')
  await a.R.releaseRun(null, job(idOn('pc-a')), 'done')
  assert.equal((await b.R.claimRun(null, job(idOn('pc-a')))).ok, false, 'done: no PC starts it again while its copy still says pending')
  assert.equal((await b.R.claimRun(null, job(idOn('pc-b', 9)))).ok, true, 'a new run of her: yes')
})

test('two PCs at the same moment: exactly one', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await Promise.all(['pc-a', 'pc-b', 'pc-c'].map(p => pcs[p].R.claimRun(null, job(idOn('pc-a', 100 + i), 100 + i))))
    assert.equal(r.filter(x => x.ok).length, 1, JSON.stringify(r))
    for (const p of ['pc-a', 'pc-b', 'pc-c']) await pcs[p].R.releaseRun(null, job(idOn('pc-a', 100 + i), 100 + i), 'failed')
  }
})

test('no office network between them: the online copy decides, by its own clock', async () => {
  net.cut.add('pc-a|pc-b'); net.cut.add('pc-b|pc-c'); net.cut.add('pc-a|pc-c')
  // queued on C, C away from both a long time ago → A may take it; B (clock 7 min ahead) asks next
  pcs['pc-a'].node.peerState.set('pc-c', { ok: false, seen: Date.now() - 10 * 60_000 })
  pcs['pc-b'].node.peerState.set('pc-c', { ok: false, seen: Date.now() - 10 * 60_000 })
  const ra = await pcs['pc-a'].R.claimRun(null, job(idOn('pc-c')))
  assert.deepEqual(ra, { ok: true, via: 'online' })
  const rb = await pcs['pc-b'].R.claimRun(null, job(idOn('pc-c')))
  assert.equal(rb.ok, false, JSON.stringify(rb))
  await pcs['pc-a'].R.releaseRun(null, job(idOn('pc-c')), 'done')
  assert.equal((await pcs['pc-b'].R.claimRun(null, job(idOn('pc-c')))).ok, false, 'done online: not again')
})

test('queued on a PC that just went away: wait for it (it may be running it, cut off)', async () => {
  pcs['pc-b'].off = true
  pcs['pc-a'].node.peerState.set('pc-b', { ok: false, seen: Date.now() - 60_000 })
  const r = await pcs['pc-a'].R.claimRun(null, job(idOn('pc-b')))
  assert.equal(r.ok, false); assert.match(r.why, /waiting for PC-B/)
  pcs['pc-a'].node.peerState.set('pc-b', { ok: false, seen: Date.now() - 6 * 60_000 })
  assert.equal((await pcs['pc-a'].R.claimRun(null, job(idOn('pc-b')))).ok, true, 'Main off / PC gone 5 min: another PC takes it')
})

test('cut off from everything: only the rows queued on this PC', async () => {
  net.down = true; net.cut.add('pc-a|pc-b'); net.cut.add('pc-b|pc-c')
  pcs['pc-b'].node.peerState.set('pc-a', { ok: false, seen: Date.now() - 60 * 60_000 })
  pcs['pc-b'].node.peerState.set('pc-c', { ok: false, seen: Date.now() - 60 * 60_000 })
  assert.deepEqual(await pcs['pc-b'].R.claimRun(null, job(idOn('pc-b'))), { ok: true, via: 'alone' })
  const other = await pcs['pc-b'].R.claimRun(null, job(idOn('pc-a', 5), 8))
  assert.equal(other.ok, false); assert.match(other.why, /only runs queued on this PC/)
})

test('a PC gone mid-run: the run is failed "stopped — PC went away", once', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await db.schema.createTable('automation_queue', t => { t.bigInteger('id'); t.string('status'); t.text('log'); t.string('pause_reason'); t.string('updated_at') })
    const id = idOn('pc-a', 50)
    await db('automation_queue').insert({ id, status: 'running', log: '[]' })
    assert.equal((await pcs['pc-a'].R.claimRun(null, job(id, 50))).ok, true)
    pcs['pc-a'].off = true; net.down = true
    const b = pcs['pc-b']
    assert.equal(await b.R.sweepGone(db, Date.now() + 7 * 60_000 + 30_000), 0, 'its lease still runs')
    b.node.peerState.set('pc-a', { ok: false, seen: Date.now() - 10 * 60_000 })
    assert.equal(await b.R.sweepGone(db, Date.now() + 7 * 60_000 + 4 * 60_000), 1)
    const row = await db('automation_queue').where({ id }).first()
    assert.equal(row.status, 'failed'); assert.match(row.pause_reason, /stopped — PC went away/); assert.match(row.log, /PC-A/)
    assert.equal(await b.R.sweepGone(db, Date.now() + 20 * 60_000), 0, 'once')
  } finally { await db.destroy() }
})

test('ADAL_ROBOTS_EVERYWHERE=0: granted as before, nobody asked', async () => {
  process.env.ADAL_ROBOTS_EVERYWHERE = '0'
  try {
    let asked = 0; pcs['pc-a'].node.others = async () => { asked++; return [] }
    assert.deepEqual(await pcs['pc-a'].R.claimRun(null, job(1)), { ok: true, via: 'off' })
    assert.equal(asked, 0)
  } finally { delete process.env.ADAL_ROBOTS_EVERYWHERE }
})

test('results come back by the PC copying: runs, their history, profile steps and uploads are copied tables', async () => {
  const T = await import('../src/services/sync/tables.js')
  for (const t of ['automation_queue', 'run_history', 'profile_automations', 'files', 'profiles']) assert.ok(!T.LOCAL.has(t), `${t} is copied`)
  assert.ok(T.ID_TABLES.includes('automation_queue'), 'a run queued on any PC gets an id that says which PC')
})

test('GET /api/run-claims: who is doing what (claims come from Adal Robots through claimBridge.js)', async () => {
  const { default: express } = await import('express')
  const { default: router } = await import('../src/routes/runClaims.js')
  const R = await import('../src/services/runClaims.js')
  R._setEnvForTests({ me: { pc_id: 'pc-x', pc_name: 'PC-X' }, node: null, store: null, slot: () => 1, isMain: () => true, now: () => Date.now() })
  const app = express(); app.use('/api', router)
  const srv = await new Promise(ok => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  try {
    const j = { id: idOn('pc-a', 77), profile_id: 77, workflow_id: 'wafid_book' }
    assert.deepEqual(await R.claimRun(null, j), { ok: true, via: 'alone' })
    const list = await fetch(`http://127.0.0.1:${srv.address().port}/api/run-claims`).then(r => r.json())
    assert.equal(list[0].key, 'wafid|77'); assert.equal(list[0].pc_name, 'PC-X'); assert.equal(list[0].here, true)
    await R.releaseRun(null, j, 'done')
  } finally { srv.close() }
})

test('ADAL_BLOCK_PEERS: a test cuts two PCs apart without root (claims and PC copying)', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const B = await import('../src/services/peerBlock.js')
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'block-')), 'cut.txt')
  fs.writeFileSync(f, '# cut\nhttp://127.0.0.1:4101\npc-b\n')
  const env = { ADAL_BLOCK_PEERS: f }
  B._resetBlockCache()
  assert.equal(B.blockedPeer('http://127.0.0.1:4101', env), true)
  assert.equal(B.blockedPeer('http://127.0.0.1:4101/api/sync/hello', env), true)
  assert.equal(B.blockedPeer('http://127.0.0.1:41011', env), false, 'another port is not cut')
  assert.equal(B.blockedPeer('pc-b', env), true); assert.equal(B.blockedPeer('pc-c', env), false)
  assert.equal(B.blockedPeer('pc-b', {}), false, 'no variable: nothing cut')
  const { SyncNode } = await import('../src/services/sync/node.js')
  process.env.ADAL_BLOCK_PEERS = f
  try {
    const n = Object.create(SyncNode.prototype); n.f = async () => { throw new Error('fetch must not be reached') }
    await assert.rejects(() => n.call('http://127.0.0.1:4101', 'GET', '/hello'), /cut \(ADAL_BLOCK_PEERS\)/)
  } finally { delete process.env.ADAL_BLOCK_PEERS }
})

test('a dead PC\'s run is failed about 105 s after it died (60 s lease + 30 s + the 15 s look)', async () => {
  const R = pcs['pc-a'].R
  assert.equal(R.LEASE_MS + R.GRACE_MS + R.SWEEP_MS, 105_000)
})
