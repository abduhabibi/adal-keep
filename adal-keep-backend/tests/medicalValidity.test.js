import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daysLeft, dueAlert } from '../src/services/medicalValidity.js'

test('days left counts the last day', () => {
  assert.equal(daysLeft('2026-10-28', new Date('2026-10-27T10:00:00')), 2)
  assert.equal(daysLeft('2026-10-27', new Date('2026-10-27T10:00:00')), 1)
  assert.equal(daysLeft('2026-10-26', new Date('2026-10-27T10:00:00')), 0)
})

test('one warning per step, the smallest step reached', () => {
  assert.equal(dueAlert(90, []), null)
  assert.equal(dueAlert(60, []).text, '2 months left')
  assert.equal(dueAlert(45, ['60']), null)
  assert.equal(dueAlert(29, ['60']).text, '1 month left')
  assert.equal(dueAlert(5, []).text, '1 week left')
  assert.equal(dueAlert(3, ['60', '30', '14', '7']).text, '3 days left')
  assert.equal(dueAlert(1, ['60', '30', '14', '7', '3']).text, '1 day left')
  assert.equal(dueAlert(0, []).text, 'has run out')
  assert.equal(dueAlert(0, ['0']), null)
})

import { medicalDeadline } from '../src/services/medicalValidity.js'

test('deadline = medical examination date + 2 months', () => {
  const rec = 'Medical center code\n09/01/08\nMedical examination date\n29/09/2026\nDate of examination in GCC'
  assert.deepEqual(medicalDeadline(rec), { exam: '2026-09-29', until: '2026-11-29' })
  assert.deepEqual(medicalDeadline('Medical examination date\n31/12/2026'), { exam: '2026-12-31', until: '2027-02-28' })
  assert.equal(medicalDeadline('no date here'), null)
})
