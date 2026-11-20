import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIONS, shows, showsForAny, stagesOf, stageOrder } from '../../adal-keep-frontend/src/lib/stageActions.js'
import { AFTER, afterInOrder, phaseOf } from '../../adal-keep-frontend/src/lib/phase.js'

test('a girl in the CV stage: no daily check-up, no Tasheer, no embassy print', () => {
  for (const k of ['day_by_day', 'tasheer_schedule', 'print_embassy', 'insurance_certificate', 'wafid_check', 'whatsapp_send', 'musaned_check_chosen'])
    assert.equal(shows(k, 'cv'), false, k)
  for (const k of ['edit', 'delete', 'create_cv', 'documents', 'make_cv']) assert.equal(shows(k, 'cv'), true, k)
})

test('each robot: its own stage and the next one', () => {
  assert.deepEqual(stagesOf('make_cv'), ['cv', 'musaned'])
  assert.deepEqual(stagesOf('musaned_add_candidate'), ['musaned', 'waiting'])
  assert.deepEqual(stagesOf('musaned_check_chosen'), ['waiting', 'selected'])
  assert.deepEqual(stagesOf('wafid_book'), ['selected', 'wafid'])
  assert.deepEqual(stagesOf('wafid_check'), ['wafid', 'lmis'])
  assert.deepEqual(stagesOf('musaned_epro_approve'), ['epro', 'tasheer'])
  assert.deepEqual(stagesOf('tasheer_schedule'), ['tasheer', 'insurance'])
  assert.deepEqual(stagesOf('police_certificate'), ['police', 'choices'])
  assert.deepEqual(stagesOf('print_embassy'), ['embassy', 'police', 'choices'])
  assert.deepEqual(stagesOf('whatsapp_send'), ['waiting'])
  assert.deepEqual(stagesOf('day_by_day'), ['waiting', 'selected', 'wafid', 'lmis', 'epro', 'tasheer', 'insurance', 'embassy', 'police', 'choices'])
})

test('after the EPRO "next" follows the agency\'s order', () => {
  const after = afterInOrder(['Enjaz · Visa', 'Tasheer', 'Insurance', 'LMIS · Police clearance'])
  assert.deepEqual(stageOrder(after).slice(7), ['embassy', 'tasheer', 'insurance', 'police', 'choices'])
  assert.deepEqual(stagesOf('musaned_epro_approve', after), ['epro', 'embassy'])
  assert.deepEqual(stagesOf('mofa_visa', after), ['embassy', 'tasheer'])
  assert.deepEqual(stagesOf('police_certificate', after), ['police', 'choices'])
})

// No Unfit stage any more (asked on 2026-11-19): an UNFIT girl stays on Wafid, where the re-check is.
test('no Unfit stage: Wafid has the re-check, LMIS the contract', () => {
  assert.ok(!stageOrder(AFTER).includes('unfit'))
  assert.ok(shows('wafid_check', 'wafid'))
  assert.ok(shows('musaned_delete', 'wafid'))
  assert.deepEqual(stagesOf('lmis_contract'), ['lmis', 'epro'])
  assert.ok(Object.keys(ACTIONS).length > 0)
})

test('every phase the Profiles page can give has buttons, and unknown ones hide nothing', () => {
  const phases = new Set([...stageOrder(AFTER), 'unfit'])
  for (const [steps, p] of [[{}, {}], [{ cv: 'done' }, {}], [{ cv: 'done', musaned: 'waiting' }, {}], [{ cv: 'done', musaned: 'done', selected: 'done', epro: 'done' }, {}]])
    assert.ok(phases.has(phaseOf(steps, p, AFTER)))
  assert.equal(shows('tasheer_schedule', null), true)
  assert.equal(shows('not_listed', 'cv'), true)
  assert.equal(showsForAny('tasheer_schedule', ['cv', 'tasheer']), true)
  assert.equal(showsForAny('tasheer_schedule', ['cv', 'musaned']), false)
  assert.equal(showsForAny('tasheer_schedule', []), true)
})
