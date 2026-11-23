// Living town = her place of birth when none is written (asked on 2026-11-23):
// saved that way, not asked for in the pop-up, and on the CV (PC and phone copy).
import test from 'node:test'
import assert from 'node:assert/strict'
import { withLivingTown, livingTownOf } from '../src/services/livingTown.js'
import { missingNow } from '../../adal-keep-frontend/src/lib/missingNow.js'
import { buildTemplateData } from '../src/services/cvRender.js'

test('an empty living town is saved as her place of birth; a written one stays', () => {
  assert.equal(withLivingTown({ place_of_birth: 'ADAMA' }).living_town, 'ADAMA')
  assert.equal(withLivingTown({ place_of_birth: 'ADAMA', living_town: ' ' }).living_town, 'ADAMA')
  assert.equal(withLivingTown({ place_of_birth: 'ADAMA', living_town: 'BISHOFTU' }).living_town, 'BISHOFTU')
  // An update: the place of birth already saved fills the empty town.
  assert.deepEqual(withLivingTown({ religion: 'Muslim' }, { place_of_birth: 'JIMMA', living_town: null }), { religion: 'Muslim', living_town: 'JIMMA' })
  assert.deepEqual(withLivingTown({ religion: 'Muslim' }, { place_of_birth: 'JIMMA', living_town: 'HARAR' }), { religion: 'Muslim' })
  assert.deepEqual(withLivingTown({ full_name: 'X' }), { full_name: 'X' })
  assert.equal(livingTownOf({ place_of_birth: 'DESSIE' }), 'DESSIE')
})

test('the CV pop-up no longer asks for living town when her place of birth is known', () => {
  const p = { passport_issue_date: '2024-04-09', marital_status: 'SINGLE', religion: 'Muslim', phone_number: '0912345678' }
  assert.ok(missingNow(p, [], 'cv').texts.some(t => t.key === 'living_town'))
  assert.ok(!missingNow({ ...p, place_of_birth: 'ADAMA' }, [], 'cv').texts.some(t => t.key === 'living_town'))
})

test('the CV shows her place of birth as living town', async () => {
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  const d = await buildTemplateData(() => q, { id: 1, place_of_birth: 'ADAMA', region: 'Oromia' }, { html_content: '', css_content: '' }, {})
  assert.equal(d.LIVING_TOWN, 'ADAMA')
})
