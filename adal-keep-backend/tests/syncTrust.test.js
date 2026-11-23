// The agency's identity (services/sync/trust.js, authority.js): anchors,
// certificates, the revoked list, the handshake and the sealed calls — no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { newSigningKey, sign, checkCert, TrustStore, TrustServer, TrustClient, agencyTag, crlVersion, ROOT_PUBS } from '../src/services/sync/trust.js'
import { Authority, approveSig, collectSig, handle, pendingSig } from '../src/services/sync/authority.js'

const root = newSigningKey()
process.env.ADAL_TRUST_ROOT_PUB = root.pub
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-trust-'))
const store = (n) => new TrustStore(path.join(dir, `${n}.json`))
const eph = () => crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x
const pcId = (n) => n.repeat(12).slice(0, 12)

async function enrol(auth, code, st, id, approver = null) {
  const { request_id } = await auth.requestJoin({ code, pc_id: id, device_pub: st.device.pub, name: id })
  if (approver) await auth.approveByPC({ request_id, cert: approver.cert, anchor: approver.anchor, sig: approveSig(approver.device.priv, { request_id, pc_id: id, device_pub: st.device.pub }) })
  else await auth.approveByAdmin(request_id)
  st.adopt(await auth.collect({ request_id, sig: collectSig(st.device.priv, request_id) }))
  return st
}

/** A client and a server talking through plain function calls (as the routes do). */
function wire(server) {
  return async (url, o) => {
    const p = new URL(url).pathname
    const body = o.body ? JSON.parse(o.body) : {}
    const reply = (status, j) => ({ ok: status < 400, status, json: async () => j })
    try {
      if (p === '/api/sync/auth/hello') return reply(200, server.hello(body))
      if (p === '/api/sync/auth/prove') return reply(200, server.prove(body))
      const c = server.openCall(o.headers['x-adal-session'], o.method, p, o.method === 'GET' ? o.headers['x-adal-box'] : body.box)
      return reply(200, server.sealAnswer(c.sid, c.n, c.session, { echo: c.body ?? null, path: p }))
    } catch (e) { return reply(e.status || 403, { error: e.message, trust: true, ...(e.session ? { session: e.session } : {}) }) }
  }
}

test('certificates: Adal root → agency → device; other agencies, made-up keys and copies refused', async () => {
  assert.equal(ROOT_PUBS.length >= 1, true)
  const auth = new Authority({ rootPriv: root.priv })
  await auth.createAgency('agency-nuzla', '47040')
  await auth.createAgency('agency-other', '11111')
  const a = await enrol(auth, '47040', store('a'), pcId('a'))
  const b = await enrol(auth, '47040', store('b'), pcId('b'), a)   // a PC of the agency says Yes
  const x = await enrol(auth, '11111', store('x'), pcId('c'))
  assert.equal(a.cert.p.slot, 1); assert.equal(b.cert.p.slot, 2)
  assert.equal(checkCert(b.anchor, b.cert, { agencyId: 'agency-nuzla' }).pc_id, pcId('b'))
  assert.throws(() => checkCert(x.anchor, x.cert, { agencyId: 'agency-nuzla' }), /another agency/)

  // A made-up agency key calling itself Adal Nuzla: no root signature.
  const fakeRoot = newSigningKey(), fakeAgency = newSigningKey()
  const ap = { v: 1, agency_id: 'agency-nuzla', agency_pub: fakeAgency.pub, issued_at: new Date().toISOString() }
  const fakeAnchor = { p: ap, s: sign(fakeRoot.priv, 'adal-agency-anchor-v1', ap) }
  const cp = { ...b.cert.p, pc_id: pcId('d'), serial: 'fake-1' }
  assert.throws(() => checkCert(fakeAnchor, { p: cp, s: sign(fakeAgency.priv, 'adal-device-cert-v1', cp) }, { agencyId: 'agency-nuzla' }), /not signed by Adal/)
  // The real anchor with a certificate the agency never signed (one field changed).
  assert.throws(() => checkCert(a.anchor, { p: { ...b.cert.p, slot: 9 }, s: b.cert.s }), /not signed by the agency/)

  // A Yes signed by a PC of ANOTHER agency does not count.
  const { request_id } = await auth.requestJoin({ code: '47040', pc_id: pcId('e'), device_pub: store('e').device.pub })
  await assert.rejects(auth.approveByPC({ request_id, cert: x.cert, anchor: x.anchor, sig: approveSig(x.device.priv, { request_id, pc_id: pcId('e'), device_pub: store('e').device.pub }) }), /another agency/)
  // Nobody but the asking PC picks up its certificate.
  await auth.approveByAdmin(request_id)
  await assert.rejects(auth.collect({ request_id, sig: collectSig(a.device.priv, request_id) }), /Not the PC that asked/)
  // Only a PC of the agency sees who asks; Admin's ops need Admin.
  const at = new Date().toISOString()
  await assert.rejects(handle(auth, { op: 'pending', agency_id: 'agency-nuzla', cert: x.cert, at, sig: pendingSig(x.device.priv, 'agency-nuzla', at) }), /another agency|Not a certificate/)
  await assert.rejects(handle(auth, { op: 'revoke', agency_id: 'agency-nuzla', pc_id: pcId('b') }), /Admin only/)
})

test('handshake + sealed calls: both sides proven, replays and tampering refused, the revoked list spreads', async () => {
  const auth = new Authority({ rootPriv: root.priv })
  await auth.createAgency('ag2', '22222')
  const a = await enrol(auth, '22222', store('a2'), pcId('1'))
  const b = await enrol(auth, '22222', store('b2'), pcId('2'), a)
  const c = await enrol(auth, '22222', store('c2'), pcId('3'), b)
  const serverA = new TrustServer(a)
  const sent = []
  const f = wire(serverA)
  const spy = async (url, o) => { sent.push({ url, o: structuredClone(o) }); return f(url, o) }
  const client = new TrustClient(b, { fetch: spy })
  const r = await client.call('http://a', 'POST', '/api/sync/push', { entries: [{ secret: 'Fatuma passport EP1234567' }] })
  assert.equal(r.echo.entries[0].secret, 'Fatuma passport EP1234567')
  assert.equal(client.peerAt('http://a').pc_id, pcId('1'))
  // What went over the network: nothing readable.
  const wireText = JSON.stringify(sent)
  assert.ok(!wireText.includes('Fatuma') && !wireText.includes('EP1234567'))
  // The same sealed call again (somebody on the Wi-Fi recorded it): refused.
  const last = sent.at(-1)
  const again = await f(last.url, last.o)
  assert.equal(again.status, 401); assert.match((await again.json()).error, /came before/)
  // The same call to another path (moved): does not open.
  const moved = await f('http://a/api/sync/pull', { ...last.o, headers: { ...last.o.headers, 'x-adal-session': last.o.headers['x-adal-session'].replace(/\.\d+$/, '.99') } })
  assert.equal(moved.status, 403)
  // A copy of B's certificate with another device key: the handshake fails at the proof.
  const thief = store('thief')
  thief.write({ anchor: b.anchor, cert: b.cert })
  assert.equal(thief.ready(), false)   // (its own key is not the certificate's)
  assert.throws(() => serverA.hello({ anchor: b.anchor, cert: b.cert, eph: 'A'.repeat(43), nonce: 'A'.repeat(22) }), /bad one-time key/)
  const h = serverA.hello({ anchor: b.anchor, cert: b.cert, eph: eph(), nonce: 'A'.repeat(22) })
  assert.throws(() => serverA.prove({ sid: h.sid, sig: sign(thief.device.priv, 'adal-pc-auth-v1|client', { t: 'x' }) }), /does not hold the key/)

  // Admin revokes C. A hears it from the cloud; B (offline) hears it from A at the next handshake.
  const cc = new TrustClient(c, { fetch: f })
  await cc.call('http://a', 'GET', '/api/sync/hello')
  const crl = await auth.revoke('ag2', pcId('3'))
  assert.ok(a.takeCRL(crl)); serverA.crlChanged()
  await assert.rejects(cc.call('http://a', 'GET', '/api/sync/hello'), /removed from the agency/)
  assert.equal(crlVersion(b.crl), 1)
  client.forget()
  await client.call('http://a', 'GET', '/api/sync/hello')
  assert.equal(crlVersion(b.crl), 2)
  assert.throws(() => new TrustServer(b).hello({ anchor: c.anchor, cert: c.cert, eph: eph(), nonce: 'A'.repeat(22) }), /removed/)
  // C joins again later (a new Yes): a new certificate works.
  const c2 = await enrol(auth, '22222', store('c3'), pcId('3'), a)
  assert.ok(a.takeCRL(await auth.crl('ag2')) === false)
  assert.equal(checkCert(c2.anchor, c2.cert, { crl: a.crl }).pc_id, pcId('3'))
  assert.equal(c2.cert.p.slot, 3)   // its slot kept
})

test('the office network sees only a hash of the agency id', () => {
  const t = agencyTag('agency-nuzla')
  assert.match(t, /^[0-9a-f]{16}$/)
  assert.ok(!t.includes('nuzla'))
  assert.notEqual(t, agencyTag('agency-other'))
})
