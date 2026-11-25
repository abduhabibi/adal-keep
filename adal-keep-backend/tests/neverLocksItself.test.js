// No Adal Keep locks by itself (owner, 2026-11-25): only Adal's signed lock (Admin → Lock),
// or the main PC cutting a PC off. A throw-away key signs here, never Adal's.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lock-'))
process.env.ADAL_LICENSE_DIR = path.join(dir, 'data')
process.env.ADAL_LICENSE_SIDE = path.join(dir, 'side')
process.env.ADAL_SUB_DIR = dir
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const U = await import('../src/services/updateChannel.js')
U._setVerifyKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
const P = await import('../src/services/plans.js')
const S = await import('../src/services/subscription.js')

const DAY = 86400000, PC = S.pcNumber()
const MAIN = '851154' === PC ? '028043' : '851154'
const sign = (l, key = privateKey) => { const license = P.signedPart(l); return { license, signature: U.signManifest(license, key) } }
const at = (min) => new Date(Date.now() + min * 60000).toISOString()
const lock = { at: at(0), note: 'call Adal' }
const put = (where, name, o) => { fs.mkdirSync(path.join(dir, where), { recursive: true }); fs.writeFileSync(path.join(dir, where, name), JSON.stringify(o)) }
const wipe = () => { for (const w of ['data', 'side']) fs.rmSync(path.join(dir, w), { recursive: true, force: true }) }
const fresh = () => { P.__resetLicenseForTest(); S.followAgencyLicence(null) }
const follow = (licence, cutOff = null) => S.followAgencyLicence(() => ({ licence, cutOff }))
test.beforeEach(() => { wipe(); fresh() })
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

/** What the guard answers on an ordinary call. */
const guard = (p = '/api/profiles') => { let out = 'next'; S.subscriptionGuard({ path: p, method: 'GET' }, { status: (c) => ({ json: (b) => { out = { c, ...b } } }) }, () => {}); return out }

test('an ended trial, ended paid time, a forged date, no licence: open ("ended" is information)', () => {
  const now = Date.now()
  assert.equal(S.computeMode({ installation_date: now - 400 * DAY, last_seen: now }), 'ended')
  const until = now - 10 * DAY
  const st = { installation_date: now - 400 * DAY, paid_until: until, paid_proof: S.paidProof(PC, until) }
  assert.equal(S.computeMode(st), 'ended')
  const pay = S.statusPayload(st)
  assert.equal(pay.suspended, false); assert.equal(pay.paidUntil, until); assert.equal(pay.paidDaysLeft, 0)
  assert.equal(S.computeMode({ installation_date: now - 400 * DAY, paid_until: now + DAY }), 'ended')
  assert.equal(S.computeMode(null), 'trial')
  assert.equal(guard(), 'next')
  assert.equal(S.isAppLocked(), false)
})

test('a wrong clock (far ahead, far back) and no internet: open', async () => {
  const now = Date.now()
  for (const s of [{ installation_date: now - 5 * DAY, last_seen: now + 900 * DAY }, { installation_date: now + 900 * DAY, last_seen: now }, { installation_date: 0, last_seen: 0 }, { installation_date: now - 4000 * DAY, last_seen: now - 4000 * DAY }]) assert.notEqual(S.computeMode(s), 'locked')
  assert.equal(await S.askInternetTime(async () => { throw new Error('offline') }), null)
})

test('a follower: today\'s failure — another PC with an ended trial holds the main role — open, its own paid time shown', () => {
  const now = Date.now()
  const u5 = { mode: 'locked', trialEndsAt: now - 17 * DAY, paidUntil: null, forGood: false, suspended: false, pcNumber: '028043' }
  follow(u5)
  assert.equal(S.computeMode({ installation_date: now - 400 * DAY }), 'ended')
  const until = now + 600 * DAY
  const paid = { installation_date: now - 400 * DAY, paid_until: until, paid_proof: S.paidProof(PC, until) }
  assert.equal(S.computeMode(paid), 'active')
  assert.equal(S.statusPayload(paid).paidUntil, until)
  for (const l of [null, {}, { ...u5, paidUntil: now - DAY }]) { follow(l); assert.notEqual(S.computeMode(paid), 'locked') }
  // "suspended" without Adal's signature is only another PC's word.
  follow({ ...u5, suspended: true, suspendNote: 'x' })
  assert.notEqual(S.computeMode(paid), 'locked')
  assert.equal(guard(), 'next')
})

test('Adal\'s signed lock: locks whatever is paid, refuses calls, and Unlock opens', () => {
  const until = Date.now() + 99 * DAY
  put('data', 'license.json', sign({ pc: PC, paid_until: until, at: at(0), suspended: lock }))
  const s = { installation_date: Date.now(), paid_until: until, paid_proof: S.paidProof(PC, until) }
  assert.equal(S.computeMode(s), 'locked')
  assert.deepEqual([S.statusPayload(s).suspended, S.statusPayload(s).suspendNote, S.statusPayload(s).paidUntil], [true, 'call Adal', until])
  assert.equal(guard().c, 402)
  assert.equal(guard('/api/subscription/status'), 'next')
  S.licenseChanged(); assert.equal(S.isAppLocked(), true)
  wipe(); fresh()
  put('data', 'license.json', sign({ pc: PC, paid_until: until, at: at(1) }))
  assert.equal(S.computeMode(s), 'active')
  S.licenseChanged(); assert.equal(S.isAppLocked(), false)
})

test('a locked PC is not opened by its files: edited, deleted, put back older, another PC\'s, another key', () => {
  const open = sign({ pc: PC, paid_until: Date.now() + 99 * DAY, at: at(-60) })
  const locked = sign({ pc: PC, at: at(0), suspended: lock })
  const s = { installation_date: Date.now() }
  const other = crypto.generateKeyPairSync('ed25519').privateKey
  put('data', 'license.json', locked)
  assert.equal(S.computeMode(s), 'locked')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'side', 'license.json'))), locked, 'kept twice')
  for (const bad of [null, open, { ...locked, license: { ...locked.license, suspended: null } }, sign({ pc: '123455', at: at(9) }), sign({ pc: PC, at: at(9) }, other)]) {
    if (bad) put('data', 'license.json', bad); else fs.rmSync(path.join(dir, 'data', 'license.json'))
    fresh()
    assert.equal(S.computeMode(s), 'locked')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'license.json'))), locked, 'put right')
  }
})

test('a follower: the main PC\'s signed lock locks it, stays with the main PC off and after a restart, opens with a newer signed one only', () => {
  const now = Date.now(), s = { installation_date: now }
  const word = (file, extra = {}) => ({ mode: 'active', paidUntil: now + DAY, forGood: true, pcNumber: MAIN, adal: file, ...extra })
  const before = sign({ pc: MAIN, at: at(-60) }), locked = sign({ pc: MAIN, at: at(0), suspended: lock }), after = sign({ pc: MAIN, at: at(5) })
  follow(word(before)); assert.equal(S.computeMode(s), 'active')
  follow(word(locked)); assert.equal(S.computeMode(s), 'locked')
  assert.equal(S.statusPayload(s).suspendNote, 'call Adal')
  follow(null); assert.equal(S.computeMode(s), 'locked', 'the main PC off')
  fresh(); assert.equal(S.computeMode(s), 'locked', 'restarted, and not following any more (it took the main role)')
  follow(word(before)); assert.equal(S.computeMode(s), 'locked', 'an older signed one opens nothing')
  follow(word({ license: { ...after.license }, signature: locked.signature })); assert.equal(S.computeMode(s), 'locked', 'a forged one opens nothing')
  follow(word(after)); assert.equal(S.computeMode(s), 'active')
  fresh(); assert.notEqual(S.computeMode(s), 'locked', 'stays open')
})

test('the main PC cutting a PC off still locks that PC, and only while it is cut off', () => {
  follow({ mode: 'active', paidUntil: Date.now() + DAY }, 'suspended')
  assert.equal(S.computeMode({ installation_date: Date.now() }), 'locked')
  assert.match(S.statusPayload({}).suspendNote, /suspended by the main PC/)
  follow({ mode: 'active', paidUntil: Date.now() + DAY })
  assert.equal(S.computeMode({ installation_date: Date.now() }), 'active')
})

test('what the main PC writes for the others: kept open for older versions, a lock passed on signed', async () => {
  const { Roles } = await import('../src/services/sync/roles.js')
  let data
  const r = Object.create(Roles.prototype)
  Object.assign(r, { node: { licenceKey: 'k', pcId: 'me' }, cache: { licence: null } })
  r.refresh = async () => {}; r.isMain = () => true; r.write = async (_k, _h, d) => { data = JSON.parse(JSON.stringify(d)) }
  await r.publishLicence({ mode: 'ended', trialEndsAt: 5, forGood: false, suspended: false }, null)
  assert.deepEqual([data.forGood, data.paidForGood], [true, false])
  const file = sign({ pc: MAIN, at: at(0), suspended: lock })
  await r.publishLicence({ mode: 'locked', suspended: true }, file)
  assert.deepEqual([data.forGood, data.suspended, data.adal], [false, true, JSON.parse(JSON.stringify(file))])
  r.cache = { licence: { data, holder: 'me' } }
  assert.ok(r.licence(), 'the signed line checks out on the other PC')
})

test('a code or a payment still adds its months while ended', () => {
  const now = Date.now(), until = now + 182 * DAY
  assert.equal(S.computeMode({ installation_date: now - 99 * DAY }), 'ended')
  assert.equal(S.computeMode({ installation_date: now - 99 * DAY, paid_until: until, paid_proof: S.paidProof(PC, until) }), 'active')
  P.__setLicenseForTest({ pc: PC, paid_until: until }); assert.equal(S.computeMode({ installation_date: now - 99 * DAY }), 'active')
})
