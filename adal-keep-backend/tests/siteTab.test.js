/**
 * One tab for each website (asked on 2026-11-18): the next Musaned run takes
 * the Musaned tab that is already open and signed in — also one an earlier
 * run still holds while it waits — instead of opening another; a tab a run
 * works in, or one waiting for a person's Save, stays that run's. After a run,
 * the extra tabs runs opened on the site are closed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openRunTab, tabOfRun, forgetRunTab, tidySiteTabs } from '../src/services/tabManager.js'
import { sameAccount } from '../src/services/musanedWorkflow.js'

function fakePage(url, name = '') {
  let closed = false
  return {
    _url: url, _name: name,
    url() { return this._url },
    isClosed: () => closed,
    async close() { closed = true },
    browserContext: () => null,
    target: () => ({ createCDPSession: async () => ({ send: async () => ({}) , on() {} }) }),
    async setRequestInterception() {},
    async evaluateOnNewDocument() {},
    on() {},
    async evaluate(fn) {
      const src = String(fn)
      if (/window\.name\s*$/.test(src.trim()) || src.includes('=> window.name')) return this._name
      if (src.includes('touched')) return { touched: 0, typed: false, name: this._name, front: false }
      return null
    },
  }
}
const fakeBrowser = (tabs) => ({ tabs, pages: async () => tabs, async newPage() { const p = fakePage('about:blank'); tabs.push(p); return p } })

test('the next Musaned run uses the Musaned tab an earlier (waiting) run holds', async () => {
  const site = fakePage('https://tawtheeq.musaned.com.sa/dashboard', 'adal-run-50')
  const browser = fakeBrowser([site])
  // Run 50 waits for a code (not a Save): its tab is the site's tab.
  const mine = await openRunTab(browser, 50, { workflowId: 'musaned_add_candidate' }).catch(() => null)
  assert.ok(mine)
  const next = await openRunTab(browser, 60, { workflowId: 'musaned_check_chosen', busyRuns: new Set([50, 60]), keepRuns: new Set([60]) })
  assert.equal(next, mine, 'no second Musaned tab')
  assert.equal(tabOfRun(50), null, 'the waiting run let go of it')
  forgetRunTab(60)
})

test('a tab waiting for a person\'s Save stays that run\'s: the next run gets its own', async () => {
  const browser = fakeBrowser([])
  const saving = await openRunTab(browser, 70, { workflowId: 'musaned_add_candidate' })
  saving._url = 'https://tawtheeq.musaned.com.sa/hr-pool/new'
  const next = await openRunTab(browser, 80, { workflowId: 'musaned_check_chosen', busyRuns: new Set([70, 80]), keepRuns: new Set([70, 80]) })
  assert.notEqual(next, saving)
  assert.equal(tabOfRun(70), saving)
  forgetRunTab(70); forgetRunTab(80)
})

test('after a run, the extra tabs runs opened on the site close; one stays', async () => {
  const a = fakePage('https://tawtheeq.musaned.com.sa/dashboard', 'adal-run-1')
  const b = fakePage('https://tawtheeq.musaned.com.sa/dashboard', 'adal-run-2')
  const person = fakePage('https://tawtheeq.musaned.com.sa/dashboard', '')   // a tab Adal Keep did not open
  const lmis = fakePage('https://lmis.gov.et/', 'adal-run-3')
  const closed = await tidySiteTabs(fakeBrowser([a, b, person, lmis]), 'musaned_add_candidate', new Set())
  assert.equal(closed, 1)
  assert.equal([a, b].filter(p => p.isClosed()).length, 1)
  assert.equal(person.isClosed(), false)
  assert.equal(lmis.isClosed(), false)
})

test('Musaned shows the account its own way: still the same account', () => {
  assert.equal(sameAccount('Adal Agency PLC', ['adal agency']), true)
  assert.equal(sameAccount('nuzla@agency.com', ['nuzla']), true)
  assert.equal(sameAccount('zadulmead', ['zadulmead', 'Zad']), true)
  assert.equal(sameAccount('other office', ['nuzla']), false)
  assert.equal(sameAccount('ab', ['abc']), false)
})
