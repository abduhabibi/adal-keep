import test from 'node:test'
import assert from 'node:assert/strict'
import { totp, luhnDigit, isPcNumber, pcNumber, codeMatches, pcSecret, computeMode, TRIAL_DAYS } from '../src/services/subscription.js'

const DAY = 86400000

test('TOTP matches the RFC 6238 test vector (what Google Authenticator computes)', () => {
  // secret "12345678901234567890", T = 59 s → 94287082 (8 digits) → 287082 (6 digits)
  assert.equal(totp(Buffer.from('12345678901234567890'), 1), '287082')
  // T = 1111111109 → 07081804 → 081804
  assert.equal(totp(Buffer.from('12345678901234567890'), Math.floor(1111111109 / 30)), '081804')
})

test('PC number: 6 digits, stable, and a one-digit slip is caught', () => {
  const pc = pcNumber()
  assert.match(pc, /^\d{6}$/)
  assert.equal(pcNumber(), pc)
  assert.ok(isPcNumber(pc))
  for (let i = 0; i < 6; i++) {
    const wrong = pc.slice(0, i) + ((+pc[i] + 3) % 10) + pc.slice(i + 1)
    assert.equal(isPcNumber(wrong), false, `typo at ${i} not caught`)
  }
  assert.equal(luhnDigit('7992739871'), '3') // classic Luhn example
})

test('a code opens only the PC it was made for, and only for about a minute', () => {
  const key = 'k'.repeat(64)
  const now = 1_800_000_000_000
  const step = Math.floor(now / 30000)
  const code = totp(pcSecret('091835', key), step)
  assert.ok(codeMatches('091835', code, now, key))
  assert.ok(codeMatches('091835', code, now + 30000, key))        // read out, typed 30 s later
  assert.equal(codeMatches('123455', code, now, key), false)      // another PC
  assert.equal(codeMatches('091835', code, now + 5 * 60000, key), false) // stale
  assert.equal(codeMatches('091835', code, now, ''), false)       // no licence key
})

test('trial → locked after the trial days; clock set back → locked', () => {
  const now = Date.now()
  assert.equal(computeMode({ installation_date: now - (TRIAL_DAYS - 1) * DAY, last_seen: now }), 'trial')
  assert.equal(computeMode({ installation_date: now - (TRIAL_DAYS + 1) * DAY, last_seen: now }), 'locked')
  assert.equal(computeMode({ installation_date: now - DAY, last_seen: now + 2 * DAY }), 'locked')
  assert.equal(computeMode({ installation_date: now - 99 * DAY, paid_until: now + DAY }), 'active')
  assert.equal(computeMode({ installation_date: now - 99 * DAY, unlocked_pc: pcNumber(), unlock_proof: 'forged' }), 'locked')
})
