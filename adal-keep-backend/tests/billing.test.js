import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-'))
process.env.ADAL_BILLING_CACHE = path.join(tmp, 'billing.json')
process.env.ADAL_FLAGS_FILE = path.join(tmp, 'flags.json')
delete process.env.ADAL_FLAG_BILLING

const B = await import('../src/services/billing.js')
const U = await import('../src/services/updateChannel.js')
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
U._setVerifyKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
const sign = (data) => ({ data, signature: U.signManifest(data, privateKey.export({ type: 'pkcs8', format: 'pem' })) })
const DAY = 86400000

test('off until the flag is on: nothing is asked or shown', async () => {
  assert.equal(B.billingOn(), false)
  assert.deepEqual(await B.refreshBilling(null, '123456', { fetcher: async () => { throw new Error('must not ask') } }), { skipped: 'flag off' })
  assert.equal(B.billingPayload({ mode: 'trial' }).enabled, false)
})

test('a payment needs a method, a reference (not for cash) and an amount; no card data fields survive', () => {
  assert.throws(() => B.normalizePayment({ method: 'card', amount: 100 }), /Method/)
  assert.throws(() => B.normalizePayment({ method: 'telebirr', amount: 30000 }), /reference/)
  assert.throws(() => B.normalizePayment({ method: 'bank', reference: 'X1', amount: 0 }), /amount/)
  const p = B.normalizePayment({ method: 'telebirr', reference: ' CK12  34 ', amount: '30000', date: '2026-11-20', card_number: '4111111111111111', cvv: '123' })
  assert.deepEqual(p, { method: 'telebirr', reference: 'CK12 34', amount: 30000, date: '2026-11-20', periods: 1, note: '' })
  assert.equal(B.normalizePayment({ method: 'bank', reference: 'R', amount: 89999 }).periods, 2)
  assert.equal(B.normalizePayment({ method: 'bank', reference: 'R', amount: 49999, term: 12 }).periods, 2)
  assert.equal(B.normalizePayment({ method: 'bank', reference: 'R', amount: 52499, term: 6, extra_pcs: 1 }).extra_pcs, 1)
  assert.throws(() => B.normalizePayment({ method: 'bank', reference: 'R', amount: 30000, periods: 99 }), /Periods/)
})

test('a payment extends from the end of what is paid, or from today when that has passed', () => {
  const now = Date.parse('2026-11-23T00:00:00Z')
  assert.equal(B.extendedUntil(null, now, 1), now + 182 * DAY)
  assert.equal(B.extendedUntil(now - 10 * DAY, now, 1), now + 182 * DAY)
  assert.equal(B.extendedUntil(now + 5 * DAY, now, 1), now + 187 * DAY)
  assert.equal(B.extendedUntil(now, now, 2), now + 364 * DAY)
})

test('the same reference is caught as a duplicate (cash never)', () => {
  const list = [{ method: 'telebirr', reference: 'ABC1' }]
  assert.ok(B.duplicateOf(list, { method: 'telebirr', reference: 'abc1' }))
  assert.equal(B.duplicateOf(list, { method: 'bank', reference: 'abc1' }), null)
  assert.equal(B.duplicateOf([{ method: 'cash', reference: '' }], { method: 'cash', reference: '' }), null)
})

test('renewal line: paid, trial, expired, suspended', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  assert.deepEqual(B.renewalOf({ licence: { paid_until: now + 3 * DAY }, firstSeen: now - 100 * DAY }, now).state, 'paid')
  assert.equal(B.renewalOf({ licence: { paid_until: now + 3 * DAY }, firstSeen: now }, now).days, 3)
  const t = B.renewalOf({ licence: null, firstSeen: now - 5 * DAY }, now)
  assert.deepEqual([t.state, t.days], ['trial', 16])
  assert.equal(B.renewalOf({ licence: { paid_until: now - 2 * DAY }, firstSeen: now - 100 * DAY }, now).state, 'expired')
  assert.equal(B.renewalOf({ licence: { suspended: { at: 'x' }, paid_until: now + DAY }, firstSeen: now }, now).state, 'suspended')
  assert.equal(B.renewalOf({ licence: { trial_until: now + 9 * DAY }, firstSeen: now - 100 * DAY }, now).days, 9)
})

test('revenue per month from the ledger', () => {
  const r = B.revenueSummary([{ date: '2026-10-02', amount: 30000 }, { date: '2026-11-05', amount: 30000 }, { date: '2026-11-20', amount: 60000 }], Date.parse('2026-11-23T00:00:00Z'))
  assert.deepEqual(r, { total: 120000, byMonth: { '2026-10': 30000, '2026-11': 90000 }, thisMonth: 90000 })
})

test('flag on: signed instructions and payments are kept; unsigned or other-PC files are ignored; offline keeps the last good', async () => {
  fs.writeFileSync(process.env.ADAL_FLAGS_FILE, JSON.stringify({ billing: true }))
  B.__resetForTest()
  const ins = { price_etb: 30000, telebirr: { name: 'Adal', number: '0995668080' }, banks: [{ bank: 'CBE', account_name: 'Adal Keep', account_number: '1000709131323' }, { bank: '', account_number: '' }], note: 'Send the reference', phone: '0995668080' }
  const files = { 'billing/instructions.json': sign(ins), 'billing/payments/123456.json': sign({ pc: '123456', payments: [{ date: '2026-11-20', method: 'telebirr', reference: 'R1', amount: 30000 }] }) }
  assert.deepEqual(await B.refreshBilling(null, '123456', { force: true, fetcher: async (p) => files[p] || null }), { ok: true })
  let p = B.billingPayload({ mode: 'active', paidUntil: Date.parse('2026-12-01T00:00:00Z'), serverTime: Date.parse('2026-11-23T00:00:00Z'), pcNumber: '123456' })
  assert.equal(p.enabled, true); assert.equal(p.has_instructions, true); assert.equal(p.instructions.banks.length, 1)
  assert.equal(p.days_left, 8); assert.equal(p.payments[0].reference, 'R1')
  // Another PC's payments file, and a tampered file, change nothing.
  const forged = sign({ pc: '999999', payments: [{ date: '2026-11-21', method: 'bank', reference: 'EVIL', amount: 1 }] })
  const tampered = { ...files['billing/instructions.json'], data: { ...ins, telebirr: { name: 'Thief', number: '0900000000' } } }
  await B.refreshBilling(null, '123456', { force: true, fetcher: async (f) => f.startsWith('billing/payments') ? forged : tampered })
  p = B.billingPayload({ mode: 'trial' })
  assert.equal(p.instructions.telebirr.number, '0995668080'); assert.equal(p.payments[0].reference, 'R1')
  // The network fails: the last good copy stays, and survives a restart.
  assert.deepEqual((await B.refreshBilling(null, '123456', { force: true, fetcher: async () => { throw new Error('offline') } })).error, 'offline')
  B.__resetForTest()
  assert.equal(B.billingPayload({ mode: 'trial' }).instructions.telebirr.number, '0995668080')
})

test('the licence key and Authenticator unlock are untouched: billing never writes the licence', () => {
  const src = fs.readFileSync(new URL('../src/services/billing.js', import.meta.url), 'utf8')
  assert.ok(!/ADAL_LICENSE_KEY|writeSide|applyCode|process\.env\.ADAL_LICENSE/.test(src.replace(/\/\*[\s\S]*?\*\//, '')))
})

test('one plan: 49,999 / 89,999 ETB, extra PCs above 3; USD-indexed mode follows the rate', () => {
  const d = B.normalizeInstructions({})
  assert.deepEqual([d.price_6m, d.price_12m, d.included_pcs, d.usd.on], [49999, 89999, 3, false])
  assert.deepEqual(B.quote(d), { six: 49999, twelve: 89999, extra: 2500, indexed: false })
  assert.equal(B.amountFor(d, 6, 2), 49999 + 5000)
  assert.equal(B.amountFor(d, 12, 2), 89999 + 10000)
  const x = { ...d, usd: { on: true, usd_6m: 400, usd_12m: 720, usd_extra: 20, rate: 125.5, rate_at: '2026-11-23' } }
  assert.deepEqual(B.quote(x), { six: 50200, twelve: 90360, extra: 2510, indexed: true, rate: 125.5, rate_at: '2026-11-23' })
  assert.equal(B.quote({ ...x, usd: { ...x.usd, rate: 0 } }).indexed, false)   // no rate yet: the ETB prices
  assert.equal(B.amountFor(x, 12, 1), 90360 + 2 * 2510)
})
