// A PC paid for itself is not locked by the trial of the PC holding the main role (Nuzla, 2026-11-25:
// DESKTOP-U5UO9NM, its own trial over, took the main role while Main was off; Main, paid until 2028,
// showed the payment lock). Adal's suspension, or the main PC cutting this PC off, still locks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-followed-'))
Object.assign(process.env, { HOME: tmp, ProgramData: tmp, ADAL_LICENSE_KEY: 'test-only-key' })
const S = await import('../src/services/subscription.js')
const DAY = 86400000, now = Date.now(), pc = S.pcNumber()
const copy = process.platform === 'win32' ? path.join(tmp, 'AdalKeep', 'sub.json') : path.join(tmp, '.config', 'adal-keep', 'sub.json')
const paid = (until, proof = S.paidProof(pc, until)) => {
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.writeFileSync(copy, JSON.stringify({ installation_date: now - 90 * DAY, ...(until ? { paid_until: until, paid_proof: proof } : {}) }))
}
const expired = { mode: 'locked', trialEndsAt: now - 17 * DAY, paidUntil: null, forGood: false, suspended: false }
const mode = (licence, cutOff = null) => { S.followAgencyLicence(() => ({ licence, cutOff })); return S.computeMode(S.readSide()) }

test('the holder\'s trial is over, this PC is paid: active', () => {
  paid(now + 300 * DAY)
  assert.equal(mode(expired), 'active')
  assert.equal(mode({ ...expired, mode: 'trial', trialEndsAt: now - DAY }), 'active')
})
test('suspended by Adal, or cut off by the main PC: locked, paid or not', () => {
  paid(now + 300 * DAY)
  assert.equal(mode({ ...expired, suspended: true }), 'locked')
  assert.equal(mode(expired, 'suspended'), 'locked')
  assert.equal(mode(expired, 'removed'), 'locked')
})
test('not paid, paid time over, or a paid date that was not signed: as the holder', () => {
  paid(0); assert.equal(mode(expired), 'locked')
  paid(now - DAY); assert.equal(mode(expired), 'locked')
  paid(now + 300 * DAY, 'f'.repeat(64)); assert.equal(mode(expired), 'locked')
})
test('the holder paid or in its trial: as before', () => {
  paid(0)
  assert.equal(mode({ ...expired, mode: 'active', paidUntil: now + DAY }), 'active')
  assert.equal(mode({ ...expired, mode: 'trial', trialEndsAt: now + DAY }), 'trial')
})
