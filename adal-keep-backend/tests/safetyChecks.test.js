/**
 * safetyChecks.test.js — asked on 2026-11-19: "getting it wrong costs money".
 *
 * The LMIS contract starts only with every value its window needs; the
 * emergency contact's ID card fills only what was really read; the insurance
 * sign-in is done by itself once each morning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { missingForLmisContract } from '../src/services/lmisContract.js'
import { emergencyUpdates } from '../src/services/emergencyId.js'
import { insuranceMorningDue, MORNING_HOUR } from '../src/services/sessionKeeper.js'

const READY = {
  labor_id: 'EF13464162', passport_number: 'EP3141592', visa_number: '6003814472',
  employer_name: 'DEMO EMPLOYER', employer_phone: '0550000000', work_city: 'Riyadh',
  musaned_pro: 'Tawssut for recruitment', destination_country: 'Saudi Arabia', emergency_labor_id: 'EF12345678',
}

test('the LMIS contract needs every value of its window', () => {
  assert.deepEqual(missingForLmisContract(READY), [])
  const { visa_number, employer_phone, emergency_labor_id, ...rest } = READY
  const missing = missingForLmisContract(rest)
  assert.ok(missing.some(m => /Visa number/.test(m)))
  assert.ok(missing.some(m => /Employer phone/.test(m)))
  assert.ok(missing.some(m => /Emergency contact Labor ID/.test(m)))
  // From her Musaned contract (contract_data) is as good as the profile's own column.
  assert.deepEqual(missingForLmisContract({ ...rest, emergency_labor_id, contract_data: JSON.stringify({ 'Visa Number': '600', 'Mobile Number': '055' }) }), [])
  // Not Saudi Arabia: no emergency contact Labor ID needed.
  assert.deepEqual(missingForLmisContract({ ...READY, destination_country: 'Jordan', emergency_labor_id: '' }), [])
})

test('the emergency ID card fills only what was read', () => {
  assert.deepEqual(emergencyUpdates({ emergency_name: ' mengesha  awano tola ', emergency_phone: '0911204381', gender: 'M' }),
    { emergency_name: 'MENGESHA AWANO TOLA', emergency_phone: '0911204381', emergency_gender: 'Male' })
  assert.deepEqual(emergencyUpdates({ emergency_name: 'ONE', emergency_phone: '12' }), {}) // one word, a short number: not read
  assert.deepEqual(emergencyUpdates({}), {})
})

test('the insurance morning sign-in: once a day, from 7, not when signed in', () => {
  const at = (h) => new Date(2026, 10, 20, h, 5)
  assert.equal(insuranceMorningDue(at(MORNING_HOUR - 1), null, false).due, false)
  const { due, day } = insuranceMorningDue(at(MORNING_HOUR), null, false)
  assert.equal(due, true)
  assert.equal(day, '2026-11-20')
  assert.equal(insuranceMorningDue(at(10), '2026-11-20', false).due, false) // done today
  assert.equal(insuranceMorningDue(at(10), '2026-11-19', true).due, false)  // already signed in
})
