// Moving an agency over to equal PCs (ADAL_EQUAL_PCS=1, docs/equal-pcs.md):
// two PCs joined the old way (the main PC's number → keys in sync_pcs) keep
// copying while one has its certificate and the other not yet; the second gets
// its certificate by a Yes from the first (/sync/vouch, with its old key — no
// click), with the slot it had; a new PC never gets a slot already in use.
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
import { newSigningKey, TrustStore } from '../src/services/sync/trust.js'
import { Authority, handle, CloudTrust, collectSig } from '../src/services/sync/authority.js'
import { attachTrust, equalRoutes, reserveSlots } from '../src/services/sync/equal.js'

process.env.ADAL_EQUAL_PCS = '1'
process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const root = newSigningKey()
process.env.ADAL_TRUST_ROOT_PUB = root.pub
const quiet = { info() {}, warn() {} }
const listen = async (app) => { const s = http.createServer(app); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s }

test('old PCs move over without losing anything: mixed copying, a Yes by the old key, slots kept', async (t) => {
  const authority = new Authority({ rootPriv: root.priv })
  const capp = express(); capp.use(express.json())
  capp.post('/', async (req, res) => { try { res.json(await handle(authority, req.body, { admin: req.headers['x-admin'] === 'yes' })) } catch (e) { res.status(e.status || 400).json({ error: e.message }) } })
  const cs = await listen(capp)
  t.after(() => { cs.close(); cs.closeAllConnections?.() })
  const curl = `http://127.0.0.1:${cs.address().port}/`
  const cloudPC = new CloudTrust({ url: curl }), admin = new CloudTrust({ url: curl, headers: { 'x-admin': 'yes' } })
  await admin.op('create', { agency_id: 'agency-nuzla', code: '47040' })

  const pcs = {}
  const mk = async (name, slot, pcId, { key = crypto.randomBytes(24).toString('base64url'), from = null } = {}) => {
    const dir = scratch(name)
    if (from) fs.copyFileSync(from, path.join(dir, 'data.sqlite'))
    const pc = await makePC(name, { slot, dir, pcId, schema: !from })
    const st = new TrustStore(path.join(dir, 'agency-trust.json'))
    const app = express(); app.use(express.json())
    let node = null
    const router = createSyncRouter({ getNode: () => node, here: () => false, keyOf: (req) => String(req.headers['x-adal-pc'] || '') })
    equalRoutes(router, { getNode: () => node, here: () => false, keyOf: (req) => String(req.headers['x-adal-pc'] || ''), st: () => st, cloudOf: async () => cloudPC })
    app.use('/api', router)
    const server = await listen(app)
    node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, key, port: server.address().port, name, addresses: () => ['127.0.0.1'], log: quiet })
    pcs[name] = { name, pc, st, server, url: `http://127.0.0.1:${server.address().port}`, get node() { return node } }
    t.after(async () => { node.stop(); server.close(); server.closeAllConnections?.(); await pc.close() })
    return pcs[name]
  }
  const A = await mk('A', 1, 'aaaaaaaaaaaa')
  await A.node.start({ timers: false, claim: true })
  await A.pc.app('profiles').insert({ full_name: 'Amina', passport_number: 'EP1' })
  await A.node.engine.stampNow()
  // The old join: A (the main PC) puts B's key on the agency's list; B starts from A's copy.
  const keyB = crypto.randomBytes(24).toString('base64url')
  await A.node.admit({ pc_id: 'bbbbbbbbbbbb', name: 'B', key: keyB, lan: ['127.0.0.1'], port: 1 })
  await A.pc.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  const B = await mk('B', 2, 'bbbbbbbbbbbb', { key: keyB, from: A.pc.file })
  await B.node.start({ timers: false, claim: false })
  await B.node.round()
  assert.equal((await B.pc.app('profiles').first()).full_name, 'Amina')

  // 1. A moves first: Admin says Yes; it keeps slot 1 and writes every slot in use to the cloud.
  const r = await cloudPC.op('request', { code: '47040', pc_id: 'aaaaaaaaaaaa', device_pub: A.st.device.pub, name: 'A', slot: 1 })
  await admin.op('admin-approve', { request_id: r.request_id })
  A.st.adopt(await cloudPC.op('collect', { request_id: r.request_id, sig: collectSig(A.st.device.priv, r.request_id) }))
  attachTrust(A.node, { st: A.st, log: quiet })
  await A.node.finder?.refresh()
  await reserveSlots(A.node, { st: A.st, cloudOf: async () => cloudPC })

  // 2. Mixed: A with its certificate, B with its key only — they still copy both ways.
  await B.pc.app('profiles').insert({ full_name: 'Bilisuma', passport_number: 'EP2' })
  await B.node.engine.stampNow()
  await A.node.round(); await B.node.round()
  assert.equal(await A.pc.app('profiles').count('* as n').first().then(x => x.n), 2)

  // 3. B moves: it asks the cloud, A says Yes for it because B called with B's own old key.
  const rb = await cloudPC.op('request', { code: '47040', pc_id: 'bbbbbbbbbbbb', device_pub: B.st.device.pub, name: 'B', slot: 2 })
  const v = await B.node.call(A.url, 'POST', '/vouch', { request_id: rb.request_id })
  assert.equal(v.slot, 2)
  // (Another PC's request is not B's to vouch for.)
  const other = await cloudPC.op('request', { code: '47040', pc_id: 'cccccccccccc', device_pub: new TrustStore(path.join(scratch('n'), 't.json')).device.pub, name: 'X' })
  await assert.rejects(B.node.call(A.url, 'POST', '/vouch', { request_id: other.request_id }), /not this PC/)
  B.st.adopt(await cloudPC.op('collect', { request_id: rb.request_id, sig: collectSig(B.st.device.priv, rb.request_id) }))
  attachTrust(B.node, { st: B.st, log: quiet })
  assert.equal(B.st.cert.p.slot, 2)

  // 4. Both certified: sealed both ways, nothing lost.
  await B.pc.app('profiles').insert({ full_name: 'Chaltu', passport_number: 'EP3' })
  await B.node.engine.stampNow()
  await A.node.round(); await B.node.round()
  assert.ok(A.node.trust.wasCertified(B.url) && B.node.trust.wasCertified(A.url))
  for (const p of [A, B]) assert.deepEqual((await p.pc.app('profiles').select('full_name').orderBy('full_name')).map(x => x.full_name), ['Amina', 'Bilisuma', 'Chaltu'])

  // 5. A new PC gets a slot no PC has (3), even though the old PCs were never asked again.
  await admin.op('admin-approve', { request_id: other.request_id })
  const got = await authority.store.get('request', other.request_id)
  assert.equal(got.cert.p.slot, 3)
})
