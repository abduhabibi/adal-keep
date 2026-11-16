// The phone draws CVs with the PC off (frontend src/lib/cvLocal.js, a copy of
// the PC's CV code): the two must give the same page for the same girl.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { buildTemplateData, mergeTemplate } from '../src/services/cvRender.js'
import { withEdits } from '../src/routes/cv.js'

const local = new URL('../../adal-keep-frontend/src/lib/cvLocal.js', import.meta.url)
const there = fs.existsSync(local)

function emptyDb() {
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  return () => q
}
const tpl = {
  salary: 1000, currency: 'SAR', country: 'SAUDI ARABIA', include_passport: 0,
  html_content: '<html><head></head><body><div class="cv-page"><table><tr><th>Read</th><td>{{ENGLISH}}</td><td>{{ARABIC}}</td></tr></table>{{FULL_NAME}} {{AGE}} {{DOB}} {{HEIGHT}} {{WEIGHT}} {{REMARKS}} {{EMERGENCY_NAME}} {{LIVING_TOWN}} {{PREV_PERIOD}} {{SALARY}} {{RELIGION}} {{PHOTO_URL}} {{FULL_BODY_PHOTO_URL}}</div></body></html>',
  css_content: '.x{max-height: 220px}',
}
const girls = [
  { id: 7, full_name: 'TEST GIRL ONE', passport_number: 'EP0000001', date_of_birth: '1995-03-04', religion: 'Muslim', middle_name: 'ABEBE', last_name: 'KEBEDE', region: 'Oromia', work_experience: 'Have experience', experience_country: 'Kuwait', experience_years: 2, speaks_arabic: 1, arabic_read: true },
  { id: 8, full_name: 'TEST GIRL TWO', height: 'Normal', weight: '', contract_data: JSON.stringify({ 'Date of Birth': '04/03/1999', Religion: 'Christian', City: 'ADAMA' }), skills: JSON.stringify({ cleaning: true }), cooking_skill: 'Cooking Helper' },
]

test('the phone and the PC fill a CV with the same words', { skip: !there && 'frontend not here' }, async () => {
  const { cvData, PHOTO_PH, BODY_PH } = await import(local)
  for (const g of girls) {
    const pc = await buildTemplateData(emptyDb(), g, tpl, { country: 'JORDAN' })
    const phone = await cvData(g, tpl, { country: 'JORDAN' })
    // The PC's own "no photo" pictures are the same picture.
    assert.equal(phone.PHOTO_URL, PHOTO_PH)
    assert.equal(phone.FULL_BODY_PHOTO_URL, BODY_PH)
    assert.deepEqual({ ...phone, DATE_TODAY: 0 }, { ...pc, DATE_TODAY: 0 }, g.full_name)
  }
})

test('the phone and the PC make the same page from the same words', { skip: !there && 'frontend not here' }, async () => {
  const L = await import(local)
  const pc = await buildTemplateData(emptyDb(), girls[0], tpl, {})
  const edits = [{ from: 'TEST GIRL ONE', to: 'TEST GIRL 1' }]
  assert.equal(L.withEdits(L.mergeTemplate(tpl.html_content, tpl.css_content, pc), edits), withEdits(mergeTemplate(tpl.html_content, tpl.css_content, pc), edits))
  const withPassport = { ...pc, PASSPORT_URL: 'data:image/jpeg;base64,AA', PASSPORT_PAGE_INCLUDE: true, HEADER_IMAGE: 'data:image/png;base64,BB' }
  assert.equal(L.mergeTemplate(tpl.html_content, '', withPassport), mergeTemplate(tpl.html_content, '', withPassport))
})
