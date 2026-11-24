import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTemplateData, mergeTemplate } from '../src/services/cvRender.js'

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

test('a CV carries its one-page fit, so preview and PDF are the same page', () => {
  const html = mergeTemplate('<div class="cv-page"><div class="cv-body">x</div></div>', '.a{}', {})
  assert.match(html, /window\.adalFit=fit/)
  assert.match(html, /\.body-photo img\{position:absolute/)
  assert.doesNotMatch(html, /\.headshot-cell img\{display:block;width:100%/) // only for capped templates
  assert.match(mergeTemplate('<div class="cv-page"></div>', '.x{max-height: 220px}', {}), /\.headshot-cell img\{display:block;width:100%/)
})

test('her full-body photo is marked for framing on her (head to feet, centred)', () => {
  const html = mergeTemplate('<div class="cv-page"><div class="body-photo"><img src="{{FULL_BODY_PHOTO_URL}}" alt=""></div><img src="{{PHOTO_URL}}"></div>', '', { FULL_BODY_PHOTO_URL: 'data:image/jpeg;base64,AA', PHOTO_URL: 'data:image/jpeg;base64,BB' })
  assert.match(html, /<img data-adal-body="1" src="data:image\/jpeg;base64,AA"/)
  assert.doesNotMatch(html, /data-adal-body="1" src="data:image\/jpeg;base64,BB"/)
  assert.match(html, /function personBox\(img\)/)
  assert.match(html, /function frameBodies\(\)/)
})

test('a new template is the hand-made page (TAMKIN and the others), only its colours differ', async () => {
  const { designHtml, DESIGN_LIST, SKELETON } = await import('../../adal-keep-frontend/src/lib/cvDesigns.js')
  for (const [id] of DESIGN_LIST) {
    const d = designHtml(id, '#0f766e', '#f59e0b')
    assert.equal(d.html, SKELETON, id)
    for (const k of ['cv-page', 'cv-header', 'cv-body', 'top-block', 'main-grid', 'body-photo', 'cv-footer', 'Details Passport', '{{PASSPORT_NO}}', '{{FULL_BODY_PHOTO_URL}}']) assert.ok(d.html.includes(k), `${id} ${k}`)
    assert.match(d.css, /\.right-col \.body-photo\{flex:1 1 auto/)
    // the same engine path: one A4 fit, the passport page from the template settings
    const out = mergeTemplate(d.html, d.css, { HEADER_IMAGE: 'data:image/png;base64,H', PASSPORT_URL: 'data:image/png;base64,P', PASSPORT_PAGE_INCLUDE: true, PASSPORT_PAGE_H1: 'Passport' })
    assert.match(out, /page-break-before:always/)
    assert.match(out, /window\.adalFit=fit/)
  }
})
