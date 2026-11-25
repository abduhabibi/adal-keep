// "When main is off, the Adal Companion should still work" (2026-11-22): the
// main role moves by itself once the main PC's lease runs out, to ONE PC (the
// smallest slot alive), and goes back to the main PC when it returns. A role a
// person moved is never moved back by itself. Also: a Companion program joins
// with the key it already has (no number typed). And what people upload
// (backend/uploads/<profile>/<field>/…) is copied like data/SafeStorage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import { makePC, scratch } from './helpers/syncPCs.js'
import { SyncNode } from '../src/services/sync/node.js'
import { createSyncRouter } from '../src/routes/sync.js'
import { LEASE, AUTO_AFTER } from '../src/services/sync/roles.js'
import { joinAgency } from '../src/services/sync/bootstrap.js'
import { okName, docNameOf } from '../src/services/sync/docs.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const quiet = { info() {}, warn() {} }

async function startPC(name, { slot, dir = scratch(name), now = () => Date.now(), key = crypto.randomBytes(24).toString('base64url'), claim = true, pcId } = {}) {
  const pc = await makePC(name, { slot, dir, schema: !fs.existsSync(path.join(dir, 'data.sqlite')), now, pcId })
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  let node = null
  app.use('/api', createSyncRouter({ getNode: () => node, here: () => true, admitted: (req) => (req.headers['x-test-number'] === '12345' ? { id: `acc-${name}`, name } : null) }))
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, uploadsDir: path.join(dir, 'uploads'), key, port, name, addresses: () => ['127.0.0.1'], log: quiet, now, licenceKey: 'k' })
  await node.start({ timers: false, claim })
  const me = { name, pc, node, server, port, url: `http://127.0.0.1:${port}`, key, dir }
  me.stop = async () => { node.stop(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); await pc.close() }
  return me
}
async function join(main, name, { now } = {}) {
  const key = crypto.randomBytes(24).toString('base64url')
  const dir = scratch(name)
  const pcId = crypto.randomBytes(6).toString('hex')
  const r = await fetch(`${main.url}/api/sync/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-pc': key, 'x-test-number': '12345' }, body: JSON.stringify({ pc_id: pcId, name, lan: ['127.0.0.1'], port: 1 }) })
  const j = await r.json()
  assert.ok(r.ok, j.error)
  await main.pc.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(main.pc.file, path.join(dir, 'data.sqlite'))
  return startPC(name, { slot: j.slot, dir, now, key, claim: false, pcId })
}

test('the main role moves by itself when Main is gone, and back when it returns', async (t) => {
  let clock = Date.now()
  const now = () => clock
  const main = await startPC('Main', { slot: 1, now })
  const comp = await join(main, 'Comp', { now })
  const third = await join(main, 'Third', { now })
  const all = [main, comp, third]
  // The time goes minute by minute, every PC looking, as on a real PC.
  const minutes = async (n, list) => { for (let i = 0; i < n; i++) { clock += 60000; for (const p of list) p.node.roles.look(await p.node.roles.pcs()) } }
  const GONE = AUTO_AFTER / 60000 + 1
  const rounds = async (list) => { for (const p of list) await p.node.round(); for (const p of list) await p.node.round() }
  try {
    await comp.node.selfRow(); await third.node.selfRow()
    await rounds(all)
    assert.equal(comp.node.roles.holder(), main.node.pcId)

    await t.test('nothing moves while Main is seen', async () => {
      assert.equal(await comp.node.roles.autoStep(), null)
      assert.equal(await third.node.roles.autoStep(), null)
    })

    await t.test('Main reached on the network counts as alive, even when its heartbeat is old', async () => {
      clock += LEASE + 60000   // (Main's own heartbeat not written since)
      await comp.node.round()
      assert.equal((await comp.node.roles.leaseOf()).alive, true)
      assert.equal(await comp.node.roles.autoStep(), null)
      await main.node.selfRow(); await rounds(all)
    })

    await t.test('Main off longer than the lease: only the first PC alive takes it', async () => {
      await main.stop()
      await minutes(GONE, [comp, third])
      await comp.node.selfRow(); await third.node.selfRow()
      await rounds([comp, third])
      assert.equal(await third.node.roles.autoStep(), null, 'not its turn: a smaller slot is alive')
      assert.equal(await comp.node.roles.autoStep(), 'taken')
      assert.equal(comp.node.roles.isMain(), true)
      assert.equal(comp.node.roles.cache.main.data.how, 'auto')
      assert.equal(comp.node.roles.cache.main.data.from, main.node.pcId)
      await rounds([comp, third])
      assert.equal(third.node.roles.holder(), comp.node.pcId, 'the others follow')
      assert.equal(await third.node.roles.autoStep(), null, 'the new holder is alive')
    })

    await t.test('Main back: it steps down when it hears, then gets its role back', async () => {
      clock += 60000
      const again = await startPC('Main', { slot: 1, dir: main.dir, now, key: main.key, claim: true, pcId: main.node.pcId })
      Object.assign(main, again)
      await main.node.round()
      assert.equal(main.node.roles.isMain(), false, 'it heard the take')
      assert.equal(await comp.node.roles.autoStep(), null, 'not reached on the network yet')
      await comp.node.round()
      assert.equal(await comp.node.roles.autoStep(), 'handed-back')
      await rounds(all)
      for (const p of all) assert.equal(p.node.roles.holder(), main.node.pcId, `${p.name} follows Main again`)
      assert.equal(await comp.node.roles.autoStep(), null)
    })

    await t.test('a hand-back waits for a run going (canHandBack false)', async () => {
      await main.stop()
      await minutes(GONE, [comp, third])
      await comp.node.selfRow(); await third.node.selfRow()
      await rounds([comp, third])
      assert.equal(await comp.node.roles.autoStep(), 'taken')
      clock += 60000
      Object.assign(main, await startPC('Main', { slot: 1, dir: main.dir, now, key: main.key, claim: true, pcId: main.node.pcId }))
      await rounds(all)
      assert.equal(await comp.node.roles.autoStep({ canHandBack: () => false }), null)
      assert.equal(await comp.node.roles.autoStep({ canHandBack: () => true }), 'handed-back')
      await rounds(all)
    })

    await t.test('a role a person took is never handed back by itself', async () => {
      await comp.node.roles.take({ force: true, by: 'person' })
      await rounds(all)
      assert.equal(main.node.roles.holder(), comp.node.pcId)
      assert.equal(await comp.node.roles.autoStep(), null)
      assert.equal(await main.node.roles.autoStep(), null, 'and Main does not take it while the holder is alive')
    })
  } finally {
    for (const p of all) await p.stop().catch(() => {})
  }
})

test('a Companion program joins with the key it already has: no number asked', async () => {
  const calls = []
  const f = async (url, o) => {
    calls.push({ url, key: o?.headers?.['x-adal-pc'] })
    if (url.endsWith('/api/sync/join')) return new Response(JSON.stringify({ slot: 7, main_pc: 'aaaaaaaaaaaa' }), { status: 200 })
    throw new Error('stop here')
  }
  await assert.rejects(joinAgency({ mainUrl: '192.168.1.4', key: 'the-companions-key', name: 'Desk', pcId: 'bbbbbbbbbbbb', f, onlineCopy: false }), /stop here/)
  assert.equal(calls[0].url, 'http://192.168.1.4:4000/api/sync/join')
  assert.equal(calls[0].key, 'the-companions-key')
  assert.ok(!calls.some(c => c.url.includes('/pc-access/number')))
})

test('uploads (folders per profile and field) are copied both ways, never outside the folder', async () => {
  const main = await startPC('UpMain', { slot: 1 })
  const comp = await join(main, 'UpComp')
  try {
    await comp.node.selfRow()
    const put = (pc, rel, body) => { const p = path.join(pc.dir, 'uploads', ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
    put(main, '12/3/a.pdf', 'from main')
    put(comp, 'general/unassigned/b.pdf', 'from the companion')
    fs.writeFileSync(path.join(main.pc.safe, 'cv.pdf'), 'a cv')
    main.node.docs.touch(); comp.node.docs.touch()
    await comp.node.round(); await main.node.round()
    const read = (pc, rel) => fs.readFileSync(path.join(pc.dir, 'uploads', ...rel.split('/')), 'utf8')
    assert.equal(read(comp, '12/3/a.pdf'), 'from main')
    assert.equal(read(main, 'general/unassigned/b.pdf'), 'from the companion')
    assert.equal(fs.readFileSync(path.join(comp.pc.safe, 'cv.pdf'), 'utf8'), 'a cv')
    // Names that would leave the folder are refused.
    for (const bad of ['uploads/../x', 'uploads//x', '/etc/passwd', 'uploads/a/../../x', '../x', 'uploads/.x']) assert.equal(okName(bad), false, bad)
    assert.equal(docNameOf('uploads/12/3/a.pdf'), 'uploads/12/3/a.pdf')
    assert.equal(docNameOf('data/SafeStorage/x.pdf'), 'x.pdf')
    assert.equal(docNameOf('uploads/../x'), null)
    const r = await fetch(`${main.url}/api/sync/doc/${encodeURIComponent('uploads/../../etc/passwd')}`, { headers: { 'x-adal-pc': comp.key } })
    assert.equal(r.status, 404)
  } finally { await main.stop(); await comp.stop() }
})
