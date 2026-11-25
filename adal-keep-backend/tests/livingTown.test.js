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
  // no place of birth either: the place is asked (the town follows it), once
  const none = missingNow(p, [], 'cv').texts.map(t => t.key)
  assert.ok(none.includes('place_of_birth') && !none.includes('living_town'))
  assert.ok(!missingNow({ ...p, place_of_birth: 'ADAMA' }, [], 'cv').texts.some(t => t.key === 'living_town'))
})

test('the CV shows her place of birth as living town', async () => {
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  const d = await buildTemplateData(() => q, { id: 1, place_of_birth: 'ADAMA', region: 'Oromia' }, { html_content: '', css_content: '' }, {})
  assert.equal(d.LIVING_TOWN, 'ADAMA')
})

test('living town is never asked: not when cleared, not from an older note in this browser, not by name', async () => {
  const kept = {}
  globalThis.localStorage = { getItem: (k) => kept[k] ?? null, setItem: (k, v) => { kept[k] = v }, removeItem: (k) => { delete kept[k] } }
  const { noteCleared } = await import('../../adal-keep-frontend/src/lib/missingNow.js')
  const p = { id: 5, passport_issue_date: '2024-04-09', marital_status: 'SINGLE', religion: 'Muslim', phone_number: '0912345678', place_of_birth: 'JIMMA', living_town: 'JIMMA' }
  noteCleared(5, { profile: p }, { profile: { ...p, living_town: '' } })
  kept['adal-cleared:5'] = JSON.stringify({ texts: ['living_town'], files: [] })   // noted by the version before
  assert.deepEqual(missingNow({ ...p, living_town: '' }, [], 'cv', 5).texts, [])
  assert.equal(kept['adal-cleared:5'], undefined, 'the old note is forgotten')
  // Neither written: the place of birth, and only that.
  assert.deepEqual(missingNow({ ...p, living_town: '', place_of_birth: '' }, [], 'cv', 5).texts.map(t => t.key), ['place_of_birth'])
  delete globalThis.localStorage
})

test('old girls: filled when read, nothing written; a corrected place of birth takes it along', async () => {
  const { fillTown } = await import('../src/services/livingTown.js')
  assert.equal(fillTown({ place_of_birth: 'JIMMA', living_town: null }).living_town, 'JIMMA')
  assert.equal(fillTown({ place_of_birth: 'JIMMA', living_town: 'HARAR' }).living_town, 'HARAR')
  assert.equal(fillTown({ place_of_birth: '', living_town: '' }).living_town, '')
  assert.deepEqual(fillTown({ id: 1, place_of_birth: 'JIMMA' }), { id: 1, place_of_birth: 'JIMMA' }, 'no such column asked for: not added')
  assert.equal(fillTown(null), null)
  process.env.ADAL_TOWN_FILL = '0'
  assert.equal(fillTown({ place_of_birth: 'JIMMA', living_town: '' }).living_town, '')
  delete process.env.ADAL_TOWN_FILL
  assert.equal(withLivingTown({ place_of_birth: 'JIMMA', living_town: 'JIMA' }, { place_of_birth: 'JIMA', living_town: null }).living_town, 'JIMMA')
  assert.equal(withLivingTown({ place_of_birth: 'JIMMA', living_town: 'HARAR' }, { place_of_birth: 'JIMA', living_town: 'HARAR' }).living_town, 'HARAR')
})
