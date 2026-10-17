/**
 * runTabs.test.js — every automation run owns exactly one browser tab.
 *
 * Two runs at once used to end up in one tab: a run adopted any tab already
 * on its portal, even one another run was paused in, and the run id lived in
 * localStorage, which all tabs of a site share. These tests pin the new rule:
 * a new run always gets a new tab, a resumed run gets its own tab back, and
 * closing one run's tab never touches another tab.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { openRunTab, tabOfRun, closeRunTab, runsWithTabs, isPeerUrl } from '../src/services/tabManager.js'

let nextTab = 1

function fakePage(url = 'about:blank') {
  let closed = false
  return {
    name: `tab-${nextTab++}`,
    _url: url,
    url() { return this._url },
    isClosed: () => closed,
    async close() { closed = true },
    target: () => ({ createCDPSession: async () => ({ send: async () => {} }) }),
    async setRequestInterception() {},
    on() {},
  }
}

function fakeBrowser(existing = []) {
  const tabs = [...existing]
  return {
    tabs,
    async newPage() { const p = fakePage(); tabs.push(p); return p },
  }
}

test('two runs at once get two different tabs, never the operator’s tab', async () => {
  // The operator already has LMIS and Musaned open in this browser.
  const own = [fakePage('https://lmis.gov.et/dashboard'), fakePage('https://tawtheeq.musaned.com.sa/dashboard')]
  const browser = fakeBrowser(own)

  const [a, b] = await Promise.all([openRunTab(browser, 9001), openRunTab(browser, 9002)])
  assert.notEqual(a, b)
  assert.ok(!own.includes(a) && !own.includes(b))
  assert.equal(tabOfRun(9001), a)
  assert.equal(tabOfRun(9002), b)

  await closeRunTab(9001)
  await closeRunTab(9002)
})

test('a resumed run gets its own tab back; another run does not', async () => {
  const browser = fakeBrowser()
  const paused = await openRunTab(browser, 9101)
  paused._url = 'https://tawtheeq.musaned.com.sa/hr-pool' // waiting for the person here

  const other = await openRunTab(browser, 9102)            // a second Musaned run
  assert.notEqual(other, paused)

  const resumed = await openRunTab(browser, 9101)          // the first run continues
  assert.equal(resumed, paused)

  await closeRunTab(9101)
  await closeRunTab(9102)
})

test('closing one run’s tab leaves every other tab open', async () => {
  const mine = fakePage('https://lmis.gov.et/')
  const browser = fakeBrowser([mine])
  const a = await openRunTab(browser, 9201)
  const b = await openRunTab(browser, 9202)

  assert.equal(await closeRunTab(9201), true)
  assert.equal(a.isClosed(), true)
  assert.equal(b.isClosed(), false)
  assert.equal(mine.isClosed(), false)
  assert.equal(tabOfRun(9201), null)
  assert.equal(await closeRunTab(9201), false) // already closed: nothing else is touched

  await closeRunTab(9202)
})

test('a tab the person closed is replaced by a new one on resume', async () => {
  const browser = fakeBrowser()
  const first = await openRunTab(browser, 9301)
  await first.close()
  assert.equal(tabOfRun(9301), null)
  assert.ok(!runsWithTabs().includes(9301))

  const again = await openRunTab(browser, 9301)
  assert.notEqual(again, first)
  await closeRunTab(9301)
})

test('portal hosts are still recognised', () => {
  assert.equal(isPeerUrl('https://tawtheeq.musaned.com.sa/dashboard', 'musaned'), true)
  assert.equal(isPeerUrl('https://accounts.wahid.sa/realms/x', 'musaned'), true)
  assert.equal(isPeerUrl('https://lmis.gov.et/auth', 'lmis'), true)
  assert.equal(isPeerUrl('https://lmis.gov.et/auth', 'musaned'), false)
})
