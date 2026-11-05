import test from 'node:test'
import assert from 'node:assert/strict'
import { plainReason, problemOf, goneFromMusaned } from '../src/services/runOutcome.js'

test('real stored failures read as something to act on', () => {
  assert.equal(plainReason('Profile is missing for Wafid: destination country (after 1 attempts)'), 'missing on the profile: destination country')
  assert.equal(plainReason('Could not reach tawtheeq.musaned.com.sa (after 3 attempts)'), 'the site was not available: try again')
  assert.equal(plainReason('Worker card not found (after 2 attempts)'), 'she was not found on the site')
  assert.equal(plainReason("Attempted to use detached Frame 'C19A'. (after 3 attempts)"), 'the page changed while working: try again')
  assert.equal(plainReason("Cannot read properties of null (reading 'width') (after 3 attempts)"), 'the page changed while working: try again')
  assert.equal(plainReason('Submit button not found (after 1 attempts)'), 'the site changed: Submit button was not there')
  assert.equal(plainReason('Retry 1/3 at 2026-11-05T10:00:00.000Z — Could not reach x'), 'the site was not available: try again')
  assert.match(plainReason('LMIS blocks this agency: "No Bank Account Found". The agency must'), /bank account/)
  assert.equal(plainReason(''), 'last run failed')
})

test('the newest standing failure is the one shown, a later success clears it', () => {
  const runs = { wafid_book: { id: 5, status: 'failed', workflow_id: 'wafid_book', pause_reason: 'Profile is missing for Wafid: x' }, lmis: { id: 9, status: 'failed', workflow_id: 'lmis', pause_reason: 'Worker card not found' } }
  assert.equal(problemOf(runs), 'LMIS: she was not found on the site')
  assert.equal(problemOf({ ...runs, lmis: { id: 9, status: 'done' } }), 'Wafid: missing on the profile: x')
  assert.equal(problemOf({}), '')
  const old = { id: 1, status: 'failed', workflow_id: 'lmis', finished_at: '2026-09-01T00:00:00Z', pause_reason: 'x' }
  assert.equal(problemOf({ lmis: old }, new Set(), Date.parse('2026-11-05')), '')
  assert.match(problemOf({ lmis: old }, new Set(), Date.parse('2026-09-05')), /LMIS/)
  assert.equal(problemOf(runs, new Set(['lmis', 'wafid_book'])), '')   // done some other way since
  assert.equal(problemOf({ a: { id: 1, status: 'failed', workflow_id: 'musaned_add_candidate', pause_reason: 'Musaned: she already exists' } }), 'Musaned: she already exists')
})

test('deleted from Musaned until she is added again', () => {
  const del = { id: 5, status: 'done' }
  assert.equal(goneFromMusaned({ musaned_delete: del }), true)
  assert.equal(goneFromMusaned({ musaned_delete: del, musaned_add_candidate: { id: 3, status: 'done' } }), true)
  assert.equal(goneFromMusaned({ musaned_delete: del, musaned_add_candidate: { id: 8, status: 'done' } }), false)
  assert.equal(goneFromMusaned({ musaned_delete: { id: 5, status: 'failed' } }), false)
})
