import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visaNames, visaValues, missingForVisa } from '../src/services/mofaVisa.js'
import { soundKind } from '../src/services/worker.js'

test('visa names: first, father, family from the full name', () => {
  assert.deepEqual(visaNames({ full_name: 'Hiwot  Getachew Zenebe' }), { first: 'HIWOT', father: 'GETACHEW', grandfather: '', family: 'ZENEBE' })
  assert.deepEqual(visaNames({ full_name: 'A B C D' }), { first: 'A', father: 'B', grandfather: 'C', family: 'D' })
})

test('visa values come from the profile and her Musaned contract', () => {
  const v = visaValues({
    full_name: 'HIWOT GETACHEW ZENEBE', gender: 'F', marital_status: 'SINGLE', religion: 'Orthodox',
    passport_number: 'e 00766797', passport_issue_date: '2026-07-17', passport_expiry_date: '2036-07-16', date_of_birth: '1999-12-19',
    employer_name: 'WASAN ALQUBBI', employer_id: '1129894141', employer_phone: '+966 55 036 8258', work_city: 'Jeddah',
    contract_data: JSON.stringify({ 'E-Mail': 'agency@example.com', 'Education level': 'Preparatory School' }),
  }, { photoPath: '/x.jpg' }, {})
  assert.equal(v.passport, 'E00766797')
  assert.equal(v.sponsor_phone, '966550368258')
  assert.equal(v.email, 'agency@example.com')
  assert.equal(v.qualification, 'Preparatory School')
  assert.match('Christian', new RegExp(v.religion, 'i'))
  assert.match('Female', new RegExp(v.gender, 'i'))
  assert.doesNotMatch('Female', new RegExp(visaValues({ gender: 'M' }).gender, 'i'))
  assert.match('King Abdulaziz Airport - Jeddah', new RegExp(v.port, 'i'))
  assert.deepEqual(missingForVisa(v), [])
  assert.ok(missingForVisa(visaValues({ full_name: 'A B' })).includes('Photo file'))
})

test('a Settings choice names the option exactly', () => {
  const v = visaValues({}, {}, { visa_duration: '90' })
  assert.match('90', new RegExp(v.duration, 'i'))
  assert.doesNotMatch('190', new RegExp(v.duration, 'i'))
})

test('each kind of run has its own sound', () => {
  const kinds = ['police_certificate', 'musaned_add_candidate', 'lmis_contract', 'wafid_book', 'mofa_visa'].map(soundKind)
  assert.equal(new Set(kinds).size, 5)
})
