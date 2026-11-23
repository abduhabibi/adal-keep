import test from 'node:test'
import assert from 'node:assert/strict'
import { isChosen, chosenNote } from '../src/services/chosen.js'
import { journeyOf, stepNow } from '../src/routes/automations.js'
import { wantsMusaned } from '../src/services/firstStage.js'
import { keepBrowserOpen } from '../src/services/tabManager.js'
import { _rememberForTest, _resetForTest } from '../src/services/remoteBrowsers.js'

// Asked on 2026-11-23: her employer's contract (from template.pdf) is on her profile, Musaned's date is not.
const jemila = { id: 748, full_name: 'J', contract_number: '2005647410', visa_number: '1908514190', employer_id: '1034269660' }

test('an employer contract on her profile is chosen; a cancelled request is not', () => {
  assert.equal(isChosen(jemila), true)
  assert.equal(isChosen({ chosen_at: '2026-11-01' }), true)
  assert.equal(isChosen({}), false)
  assert.equal(isChosen({ contract_number: ' ' }), false)
  assert.equal(isChosen({ ...jemila, musaned_stage: 'CANCELLED' }), false)
  assert.equal(chosenNote(jemila), 'contract 2005647410')
})

test('she is Selected with CV and Musaned behind her, and the next step is Wafid', () => {
  const j = journeyOf(jemila, {}, true)
  const at = Object.fromEntries(j.embassy.map(s => [s.key, s]))
  assert.equal(at.selected.state, 'done')
  assert.equal(at.selected.note, 'contract 2005647410')
  assert.equal(at.cv.state, 'done')
  assert.equal(at.musaned.state, 'done')
  assert.equal(stepNow(jemila, j).key, 'wafid')
})

test('a chosen girl is never queued for Musaned: Add candidate by the scanner', () => {
  assert.equal(wantsMusaned(jemila, {}, true), false)
  assert.equal(wantsMusaned({ id: 1 }, {}, true), true)
})

test('the last tab of a Companion browser is never closed alone: a blank one is opened first', async () => {
  _resetForTest()
  const opened = []
  const page = { isClosed: () => false }
  const browser = { pages: async () => [page], newPage: async () => { opened.push(1); return {} } }
  page.browser = () => browser
  assert.equal(await keepBrowserOpen(page), false)          // not a Companion's browser: unchanged
  _rememberForTest(browser, { id: 'C', name: 'Nuzla' })
  assert.equal(await keepBrowserOpen(page), true)
  assert.equal(opened.length, 1)
  const other = { isClosed: () => false }
  browser.pages = async () => [page, other]
  assert.equal(await keepBrowserOpen(page), false)          // another tab is open: nothing to do
})
