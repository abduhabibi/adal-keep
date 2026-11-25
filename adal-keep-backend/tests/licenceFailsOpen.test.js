// An error in the licence work never stops Adal Keep opening (owner, 2026-11-25), and never
// lifts a signed lock already received. A throw-away key signs here, never Adal's.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-failopen-'))
Object.assign(process.env, { ADAL_LICENSE_DIR: path.join(dir, 'data'), ADAL_LICENSE_SIDE: path.join(dir, 'side'), ADAL_SUB_DIR: path.join(dir, 'sub') })
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const U = await import('../src/services/updateChannel.js')
U._setVerifyKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
const L = await import('../src/services/adalLock.js')
const S = await import('../src/services/subscription.js')
const PC = S.pcNumber()
const sign = (l) => { const license = L.signedPart(l); return { license, signature: U.signManifest(license, privateKey) } }
const locked = sign({ pc: PC, at: new Date().toISOString(), suspended: { at: 'x', note: 'n' } })
const NAMES = ['data/license.json', 'side/license.json', 'data/agency-license.json', 'side/agency-license.json', 'sub/.adal_sub.json', 'sub/sub-copy.json']
const wipe = () => { for (const d of ['data', 'side', 'sub']) fs.rmSync(path.join(dir, d), { recursive: true, force: true }) }
const put = (n, text) => { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const call = (p) => { let code = 200, calls = 0; S.subscriptionGuard({ path: p, method: 'GET' }, { status: (c) => ({ json: () => { code = c } }) }, () => { calls++ }); assert.ok(calls <= 1); return code }
test.beforeEach(() => { wipe(); L.__resetLicenseForTest(); S.followAgencyLicence(null); S.licenseChanged() })
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
const opens = (why) => {
  assert.equal(call('/api/profiles'), 200, why); assert.equal(call('/uploads/a.jpg'), 200, why)
  const st = S.statusPayload(); assert.notEqual(st.mode, 'locked', why); assert.equal(st.suspended, false, why)
  S.licenseChanged(); assert.equal(S.isAppLocked(), false, why)
}

test('files broken in every way: it opens', () => {
  const bad = ['', '{', 'null', '5', '"x"', '[]', '[null]', '{}', '{"license":null}', '{"license":5,"signature":5}', '{"license":{"suspended":true},"signature":"x"}', '{"license":{"features":5,"offers":{},"pc":{},"suspended":{"note":{}}},"signature":{}}',
    '{"851154":null,"x":{"license":{},"signature":1}}', '{"installation_date":"x","last_seen":{},"paid_until":[],"paid_proof":5,"clock":"x","unlocked_pc":{},"tries":5}', '{"clock":{"offset":1e300,"at":1e300},"installation_date":1e300}', JSON.stringify({ ...locked, signature: locked.signature.slice(4) })]
  for (const n of NAMES) for (const b of bad) { wipe(); L.__resetLicenseForTest(); put(n, b); opens(`${n}: ${b}`) }
})

test('folders where files belong, nothing that can be read or written: it opens', () => {
  for (const n of NAMES) fs.mkdirSync(path.join(dir, n), { recursive: true })
  opens('folders')
  wipe(); L.__resetLicenseForTest()
  for (const d of ['data', 'side', 'sub']) fs.writeFileSync(path.join(dir, d), 'a file where the folder belongs')
  opens('no folder')
})

test('parts that throw: the main PC\'s word, this PC\'s number, the dates', () => {
  const boom = () => { throw new Error('boom') }
  S.followAgencyLicence(boom); opens('follow throws')
  for (const licence of [5, 'x', { paidUntil: {}, trialEndsAt: 'x', adal: 5 }, { adal: { signature: 'x', license: 5 } }, { get adal() { boom() } }]) { S.followAgencyLicence(() => ({ licence, cutOff: null })); opens(JSON.stringify(Object.keys(licence))) }
  S.followAgencyLicence(null)
  assert.equal(L.lockNow({ pc: boom, follow: boom }), null)
  const s = new Proxy({}, { get: boom, has: boom })
  assert.equal(S.computeMode(s), 'ended')
  assert.equal(S.statusPayload(s).mode, 'ended')
})

test('a signed lock already received stays when a part fails, and a broken status still says locked', () => {
  put('data/license.json', JSON.stringify(locked))
  assert.equal(call('/api/profiles'), 402)
  const boom = () => { throw new Error('boom') }
  assert.ok(L.lockNow({ pc: boom, follow: boom }), 'the licence in use is not read again, the lock stays')
  S.followAgencyLicence(boom)
  assert.equal(call('/api/profiles'), 402)
  const s = new Proxy({}, { get: boom, has: boom })
  assert.deepEqual([S.computeMode(s), S.statusPayload(s).suspended], ['locked', true])
  // Deleted while it runs: still locked, and written back at the next start's reading of the other copy.
  fs.rmSync(path.join(dir, 'data', 'license.json')); L.__resetLicenseForTest(); S.followAgencyLicence(null)
  assert.equal(call('/api/profiles'), 402)
})
