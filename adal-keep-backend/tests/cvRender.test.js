import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTemplateData } from '../src/services/cvRender.js'

// A knex stand-in: every query finds nothing (no files, no broker).
function emptyDb() {
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  return () => q
}
const tpl = { html_content: '', css_content: '' }

test('skills ticked on the CV form are listed even when the profile saved none', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1 }, tpl, { skills: { cleaning: true, ironing: false, washing: true, baby_sitting: false }, cooking_skill: 'None' })
  assert.equal(d.SKILL_CLEANING, '✓'); assert.equal(d.SKILL_WASHING, '✓')
  assert.equal(d.SKILL_IRONING, ''); assert.equal(d.SKILL_COOKING, '')
  assert.equal(d.REMARKS, 'She can do cleaning and washing.')
})

test('no skills anywhere → the four housework skills (the form defaults)', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1, skills: null }, tpl, {})
  for (const k of ['SKILL_CLEANING', 'SKILL_IRONING', 'SKILL_WASHING', 'SKILL_BABY_SITTING']) assert.equal(d[k], '✓', k)
})

test('a cooking level ticks Cooking and appears in the sentence', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1 }, tpl, { skills: { cleaning: true }, cooking_skill: 'Cooking Helper' })
  assert.equal(d.SKILL_COOKING, '✓')
  assert.equal(d.REMARKS, 'She can do cleaning and cooking helper.')
})

test('"Have experience" on the profile fills the experience rows', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1, work_experience: 'Have experience', experience_country: 'Kuwait', experience_years: 2 }, tpl, {})
  assert.equal(d.PREV_COUNTRY, 'Kuwait')
  assert.equal(d.PREV_PERIOD, '2 years')
  const none = await buildTemplateData(emptyDb(), { id: 1, work_experience: 'No experience' }, tpl, {})
  assert.equal(none.PREV_COUNTRY, '-')
})

test('living town falls back to the region', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1, region: 'Oromia', place_of_birth: 'HALABA' }, tpl, {})
  assert.equal(d.LIVING_TOWN, 'Oromia')
})
