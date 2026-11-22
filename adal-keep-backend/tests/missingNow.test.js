// The profile page's "Missing" card (frontend src/lib/missingNow.js) and the CV's
// living town / Date of Issue (backend cvRender + the phone's cvLocal copy).
import test from 'node:test'
import assert from 'node:assert/strict'
import { missingNow } from '../../adal-keep-frontend/src/lib/missingNow.js'
import { buildTemplateData } from '../src/services/cvRender.js'

const F = (name, n = 0) => ({ name, files: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) })
const full = { living_town: 'ADAMA', passport_issue_date: '2024-04-09', marital_status: 'SINGLE', religion: 'Muslim', phone_number: '0912345678', passport_expiry_date: '2034-04-09', date_of_birth: '2000-01-01', passport_number: 'EP1' }
const keys = (m) => m.texts.map(t => t.key)

test('CV step asks for both photos, living town and Date of Issue', () => {
  const m = missingNow({ marital_status: 'SINGLE', religion: 'Muslim', phone_number: '0912345678' }, [F('Photo'), F('Full Body Photo')], 'cv')
  assert.deepEqual(m.files, ['Photo', 'Full Body Photo'])
  assert.deepEqual(keys(m), ['living_town', 'passport_issue_date'])
})

test('the next step (Musaned) is asked for early: religion, marital status, a real mobile', () => {
  const m = missingNow({ ...full, religion: '', marital_status: ' ', phone_number: '12345' }, [F('Photo', 1), F('Full Body Photo', 1)], 'cv')
  assert.deepEqual(keys(m), ['marital_status', 'religion', 'phone_number'])
})

test('filled or uploaded things leave; nothing missing → empty (no card)', () => {
  const m = missingNow(full, [F('Photo', 1), F('Full Body Photo', 2)], 'cv')
  assert.deepEqual(m, { files: [], texts: [] })
})

test('Wafid and LMIS ask for the passport dates', () => {
  assert.deepEqual(keys(missingNow({ ...full, passport_issue_date: '' }, [], 'selected')), ['passport_issue_date'])
  assert.deepEqual(keys(missingNow({ ...full, passport_expiry_date: '', date_of_birth: null }, [], 'wafid')), ['passport_expiry_date', 'date_of_birth'])
  assert.deepEqual(keys(missingNow({ ...full, passport_number: '' }, [], 'wafid')), ['passport_number'])
})

function emptyDb() {
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  return () => q
}
test('living town and Date of Issue reach the CV', async () => {
  const d = await buildTemplateData(emptyDb(), { id: 1, living_town: 'ADAMA', region: 'Oromia', passport_issue_date: '2024-04-09' }, { html_content: '', css_content: '' }, {})
  assert.equal(d.LIVING_TOWN, 'ADAMA')
  assert.equal(d.PASSPORT_ISSUE_DATE, '09 APR 2024')
})
