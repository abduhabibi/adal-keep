/**
 * lmisKeepSignedIn.test.js — LMIS stays signed in (asked on 2026-11-15).
 *
 * The keep-alive clicks two of LMIS's own menu links (never one that signs
 * out, deletes, pays or opens a new form), and a run in a tab that is already
 * signed in carries on there: no page is loaded, nothing copied.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { pickLmisLinks } from '../src/services/sessionKeeper.js'
import { borrowSignIn } from '../src/services/tabManager.js'

test('keep-alive picks a menu page away, then the link back', () => {
  const links = [
    { path: '/new-agency/dashboard', text: 'Dashboard', menu: true },
    { path: '/new-agency/police-certificate', text: 'Police Certificate', menu: true },
    { path: '/auth', text: 'Logout', menu: true },
    { path: '/new-agency/labor/add', text: 'Add New', menu: false },
  ]
  const pick = pickLmisLinks(links, '/new-agency/dashboard')
  assert.deepEqual(pick.map(l => l.path), ['/new-agency/police-certificate', '/new-agency/dashboard'])
})

test('keep-alive never picks a risky link, and finds nothing on a page with none', () => {
  const risky = [
    { path: '/new-agency/x', text: 'Log out', menu: true },
    { path: '/new-agency/payment', text: 'Payments', menu: true },
    { path: '/new-agency/delete-labour', text: 'Labour', menu: true },
  ]
  assert.equal(pickLmisLinks(risky, '/new-agency/dashboard').length, 0)
  assert.equal(pickLmisLinks([], '/').length, 0)
})

function fakeTab(url, { signedIn = true } = {}) {
  const tab = {
    loads: 0, copied: 0,
    url: () => url,
    async goto() { tab.loads++ },
    async evaluateOnNewDocument() { tab.copied++ },
    async evaluate() { return { pub: false, pw: !signedIn, drawn: true, data: '{}' } },
  }
  tab.targetObj = { type: () => 'page', url: () => url, page: async () => tab, _targetId: url + Math.random() }
  tab.target = () => tab.targetObj
  return tab
}

test('a run in the signed-in LMIS tab carries on in it (nothing copied, no page load)', async () => {
  const other = fakeTab('https://lmis.gov.et/new-agency/dashboard')
  const mine = fakeTab('https://lmis.gov.et/new-agency/police-certificate')
  const targets = [other.targetObj, mine.targetObj]
  mine.browser = () => ({ targets: () => targets })
  const url = await borrowSignIn(mine, 'lmis')
  assert.equal(url, mine.url())
  assert.equal(mine.__adalSignedInHere, true)
  assert.equal(mine.copied, 0)
  assert.equal(mine.loads, 0)
})

test('a new tab uses the other tab’s sign-in', async () => {
  const other = fakeTab('https://lmis.gov.et/new-agency/dashboard')
  const mine = fakeTab('about:blank')
  const targets = [other.targetObj, mine.targetObj]
  mine.browser = () => ({ targets: () => targets })
  const url = await borrowSignIn(mine, 'lmis')
  assert.equal(url, other.url())
  assert.equal(mine.__adalSignedInHere, false)
  assert.equal(mine.copied, 1)
})
