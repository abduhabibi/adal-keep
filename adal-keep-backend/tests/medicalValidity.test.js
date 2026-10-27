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
