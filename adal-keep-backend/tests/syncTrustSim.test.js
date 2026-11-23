// Every PC equal (ADAL_EQUAL_PCS=strict, docs/equal-pcs.md): three PCs of one
// agency, each its own server, database and certificate, plus Adal's cloud
// (authority.js behind its one door) — and intruders: a PC of another agency,
// a made-up agency, a thief with a copied certificate, a replay. No main PC:
// any PC lets a new one in, the first copy comes from any PC, the role goes to
// the strongest PC on, a revoked PC is cut off everywhere, offline too.
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
import { LEASE } from '../src/services/sync/roles.js'
import { newSigningKey, sign, TrustStore, TrustClient, agencyTag, crlVersion } from '../src/services/sync/trust.js'
import { Authority, handle, CloudTrust, approveSig, collectSig } from '../src/services/sync/authority.js'
import { attachTrust, applyCRL } from '../src/services/sync/equal.js'
import { PeerFinder } from '../src/services/sync/peers.js'
import { snapshotSource, joinFromPeer } from '../src/services/sync/bootstrap.js'

process.env.ADAL_EQUAL_PCS = 'strict'
process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const root = newSigningKey()
process.env.ADAL_TRUST_ROOT_PUB = root.pub
const quiet = { info() {}, warn() {} }
const listen = async (app) => { const s = http.createServer(app); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s }

/** Adal's cloud: the authority behind one door (as the Supabase function agency-trust). */
async function startCloud(now) {
  const authority = new Authority({ rootPriv: root.priv, now })
  const app = express(); app.use(express.json())
  app.post('/', async (req, res) => { try { res.json(await handle(authority, req.body, { admin: req.headers['x-admin'] === 'yes' })) } catch (e) { res.status(e.status || 400).json({ error: e.message }) } })
  const server = await listen(app)
  const url = `http://127.0.0.1:${server.address().port}/`
  return { authority, server, pc: new CloudTrust({ url }), admin: new CloudTrust({ url, headers: { 'x-admin': 'yes' } }), stop: () => new Promise(r => { server.close(r); server.closeAllConnections?.() }) }
}

/** A PC asks the cloud to join; approve() says Yes (a PC or Admin); it collects its certificate. */
async function joinCloud(cloud, st, { code, pcId, approve }) {
  const { request_id } = await cloud.pc.op('request', { code, pc_id: pcId, device_pub: st.device.pub, name: pcId })
  await approve({ request_id, pc_id: pcId, device_pub: st.device.pub })
  const got = await cloud.pc.op('collect', { request_id, sig: collectSig(st.device.priv, request_id) })
  return st.adopt(got)
}
const byAdmin = (cloud) => (r) => cloud.admin.op('admin-approve', { request_id: r.request_id })
const byPC = (cloud, pc) => (r) => cloud.pc.op('approve', { request_id: r.request_id, anchor: pc.st.anchor, cert: pc.st.cert, sig: approveSig(pc.st.device.priv, r) })

async function startPC(name, { st, dir, now, schema, claim, power, f = fetch }) {
  const cert = st.cert.p
  const pc = await makePC(name, { slot: cert.slot, dir, schema, now, pcId: cert.pc_id })
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  let node = null
  const joinData = { keys: () => ({ password: 'agency-backup-key' }), ...snapshotSource({ db: pc.db, dir: path.join(dir, 'tmp') }) }
  app.use('/api', createSyncRouter({ getNode: () => node, here: () => false, joinData }))
  const server = await listen(app)
  const port = server.address().port
  node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, key: crypto.randomBytes(24).toString('base64url'), port, name, addresses: () => ['127.0.0.1'], fetch: f, log: quiet, now, licenceKey: 'test-licence-key' })
  attachTrust(node, { st, log: quiet, f })
  node.finder = new PeerFinder(node, { udp: null, targets: () => [] })
  await node.start({ timers: false, claim })
  await node.roles.publishPower({ score: power })
  const me = { name, pc, node, st, server, port, url: `http://127.0.0.1:${port}`, dir }
  me.stop = async () => { node.stop(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); await pc.close() }
  return me
}

/** A new PC: certificate first, then its first copy from `from` (any PC of the agency) over the sealed channel. */
async function newPC(cloud, name, { from, approve, now, power }) {
  const dir = scratch(name)
  const st = new TrustStore(path.join(dir, 'agency-trust.json'))
  const pcId = crypto.randomBytes(6).toString('hex')
  await joinCloud(cloud, st, { code: '47040', pcId, approve })
  const client = new TrustClient(st)
  const got = await joinFromPeer({ url: from.url, call: (u, m, p, b, o) => client.call(u, m, p, b, o) })
  assert.equal(got.secrets.password, 'agency-backup-key')
  fs.writeFileSync(path.join(dir, 'data.sqlite'), got.raw)
  return startPC(name, { st, dir, now, schema: false, claim: false, power })
}
const names = async (pc) => (await pc.pc.app('profiles').select('full_name').orderBy('full_name')).map(r => r.full_name)
const roundAll = async (pcs, n = 3) => { for (let i = 0; i < n; i++) for (const p of pcs) await p.node.round() }

test('three equal PCs and intruders: certificates decide, sealed copying, the role with the strongest, revoked everywhere', async (t) => {
  let clock = Date.now()
  const now = () => clock
  const cloud = await startCloud(now)
  await cloud.admin.op('create', { agency_id: 'agency-nuzla', code: '47040' })
  await cloud.admin.op('create', { agency_id: 'agency-other', code: '11111' })
  t.after(() => cloud.stop())

  // ── A: the agency's first PC (Admin says Yes). B: A says Yes, copy from A. C: B says Yes, copy from B.
  const dirA = scratch('A')
  const stA = new TrustStore(path.join(dirA, 'agency-trust.json'))
  await joinCloud(cloud, stA, { code: '47040', pcId: 'aaaaaaaaaaaa', approve: byAdmin(cloud) })
  const A = await startPC('A', { st: stA, dir: dirA, now, schema: true, claim: true, power: 8 })   // the 2-core A4
  t.after(() => A.stop())
  await A.pc.app('profiles').insert({ full_name: 'Amina', passport_number: 'EP0000001', status: 'new' })
  await A.node.engine.stampNow()
  const B = await newPC(cloud, 'B', { from: A, approve: byPC(cloud, A), now, power: 24 })
  t.after(() => B.stop())
  const C = await newPC(cloud, 'C', { from: B, approve: byPC(cloud, B), now, power: 16 })
  t.after(() => C.stop())
  assert.deepEqual([A, B, C].map(p => p.st.cert.p.slot), [1, 2, 3])
  assert.deepEqual(await names(C), ['Amina'])   // the first copy came from B, never from a "main PC"

  // ── Edits on every PC meet on every PC (each knows the others from the copied list).
  await roundAll([B, C, A])
  await B.pc.app('profiles').insert({ full_name: 'Bilisuma', passport_number: 'EP0000002' })
  await C.pc.app('profiles').insert({ full_name: 'Chaltu', passport_number: 'EP0000003' })
  for (const p of [B, C]) await p.node.engine.stampNow()
  await roundAll([A, B, C])
  for (const p of [A, B, C]) assert.deepEqual(await names(p), ['Amina', 'Bilisuma', 'Chaltu'], p.name)
  // Everything went sealed: the key alone is refused (strict).
  const plain = await fetch(`${A.url}/api/sync/pull`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-pc': B.node.key }, body: '{"vector":{}}' })
  assert.equal(plain.status, 401)

  // ── Intruder 1: a real PC of ANOTHER agency (its own valid certificate).
  const stX = new TrustStore(path.join(scratch('X'), 't.json'))
  await joinCloud(cloud, stX, { code: '11111', pcId: 'dddddddddddd', approve: byAdmin(cloud) })
  await assert.rejects(new TrustClient(stX).call(A.url, 'POST', '/api/sync/pull', { vector: {} }), /another agency/)
  // Intruder 2: a made-up "Adal Nuzla" (its own root and agency key).
  const fr = newSigningKey(), fa = newSigningKey()
  const stF = new TrustStore(path.join(scratch('F'), 't.json'))
  const ap = { v: 1, agency_id: 'agency-nuzla', agency_pub: fa.pub, issued_at: new Date().toISOString() }
  const cp = { v: 1, agency_id: 'agency-nuzla', pc_id: 'eeeeeeeeeeee', slot: 7, name: 'F', device_pub: stF.device.pub, serial: 'fake-1', issued_at: new Date().toISOString() }
  stF.write({ anchor: { p: ap, s: sign(fr.priv, 'adal-agency-anchor-v1', ap) }, cert: { p: cp, s: sign(fa.priv, 'adal-device-cert-v1', cp) } })
  const hf = await fetch(`${A.url}/api/sync/auth/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anchor: stF.anchor, cert: stF.cert, eph: crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x, nonce: 'A'.repeat(22) }) })
  assert.equal(hf.status, 403); assert.match((await hf.json()).error, /not signed by Adal/)
  // Intruder 3: B's certificate copied (it is shown to every PC B meets) with the thief's own key.
  const thief = new TrustStore(path.join(scratch('T'), 't.json'))
  thief.write({ anchor: B.st.anchor, cert: B.st.cert })
  thief.ready = () => true
  await assert.rejects(new TrustClient(thief).call(A.url, 'GET', '/api/sync/hello'), /does not hold the key/)
  // Intruder 4: a recorded sealed call from B to A, sent again.
  const seen = []
  B.node.trust.f = async (u, o) => { seen.push({ u, o }); return fetch(u, o) }
  await B.node.call(A.url, 'POST', '/pull', { vector: {} })
  const rec = seen.find(s => s.u.endsWith('/api/sync/pull'))
  assert.ok(!rec.o.body.includes('Amina'))
  const rep = await fetch(rec.u, rec.o)
  assert.equal(rep.status, 401); assert.match((await rep.json()).error, /came before/)
  B.node.trust.f = fetch
  // The office network: an announcement with the agency's tag (copied from the air) only adds an
  // address to try; another tag is not listened to.
  const tag = agencyTag('agency-nuzla')
  assert.deepEqual(A.node.finder.tags, [tag])
  assert.equal(A.node.finder.heard(`ADAL_KEEP_PEER_V1|${agencyTag('agency-other')}|dddddddddddd|4000|127.0.0.1||X`, { address: '127.0.0.1' }), null)
  A.node.finder.heard(`ADAL_KEEP_PEER_V1|${tag}|eeeeeeeeeeee|1|127.0.0.1||F`, { address: '127.0.0.1' })
  const r1 = await A.node.round()
  assert.equal(r1.last.peers.find(p => p.pc === 'eeeeeeeeeeee')?.ok, false)
  assert.equal(await A.pc.db('sync_pcs').where({ pc_id: 'eeeeeeeeeeee' }).first(), undefined)
  A.node.finder.found.delete('eeeeeeeeeeee')
  assert.ok(A.node.trustServer.refused >= 4)

  // ── The role: A had it (first PC); B (3× stronger) is on → it goes to B; B off → C (stronger than A).
  assert.equal(A.node.roles.holder(), 'aaaaaaaaaaaa')
  await roundAll([A, B, C], 1)
  assert.equal(await A.node.roles.autoStepEqual(), 'handed-stronger')
  await roundAll([A, B, C], 2)
  for (const p of [A, B, C]) assert.equal(p.node.roles.holder(), B.node.pcId, p.name)
  await B.node.selfRow(); await roundAll([A, C, B], 1)
  await new Promise(r => B.server.close(r)); B.server.closeAllConnections?.()
  clock += LEASE + 60000
  await A.node.selfRow(); await C.node.selfRow(); await roundAll([A, C], 2)
  assert.equal(await A.node.roles.autoStepEqual(), null)        // A is not the strongest alive
  assert.equal(await C.node.roles.autoStepEqual(), 'taken')
  await roundAll([A, C], 2)
  assert.equal(A.node.roles.holder(), C.node.pcId)

  // ── Revoked in Admin: C is cut off by A at once (A online), and by B offline (it hears it from A).
  const bServer = await new Promise(r => { const s = http.createServer(B.server.listeners('request')[0]); s.listen(B.port, '127.0.0.1', () => r(s)) })
  t.after(() => { bServer.close(); bServer.closeAllConnections?.() })
  const { crl } = await cloud.admin.op('revoke', { agency_id: 'agency-nuzla', pc_id: C.node.pcId })
  assert.ok(A.st.takeCRL(crl)); await applyCRL(A.node, A.st)
  await assert.rejects(C.node.call(A.url, 'GET', '/hello'), /removed|refused|401|403/)
  await cloud.stop()                              // the internet is gone from here on
  assert.equal(crlVersion(B.st.crl), 1)
  B.node.trust.forget()
  await B.node.round()                            // B meets A: the newer list comes with A's hello
  assert.equal(crlVersion(B.st.crl), 2)
  await assert.rejects(C.node.call(B.url, 'GET', '/hello'), /removed/)
  // ...and with no cloud at all A and B still recognise each other (everything is on disk).
  A.node.trust.forget(); B.node.trust.forget()
  await A.pc.app('profiles').insert({ full_name: 'Derartu', passport_number: 'EP0000004' })
  await A.node.engine.stampNow()
  await roundAll([A, B], 2)
  assert.deepEqual(await names(B), ['Amina', 'Bilisuma', 'Chaltu', 'Derartu'])
  // C's row says removed on every PC that heard it (so its old key is refused as well).
  for (const p of [A, B]) assert.ok((await p.pc.db('sync_pcs').where({ pc_id: C.node.pcId }).first()).revoked_at, p.name)
})
