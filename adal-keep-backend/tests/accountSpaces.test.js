/**
 * accountSpaces.test.js — asked on 2026-11-15:
 *  - a run uses the tab already signed in to its site instead of a new tab
 *    that signs in again — never the tab a person is on (2026-11-16): then a
 *    tab behind it, which borrows the sign-in;
 *  - each portal account other than the main one works in a browser space of
 *    its own, so two Musaned accounts are signed in side by side, and a run
 *    never takes a tab of another account's space.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
// (The spaces' list of this test only, never the PC's own.)
process.env.ADAL_SPACES_FILE = path.join(os.tmpdir(), `adal-spaces-test-${process.pid}.json`)
const { spaceForAccount, openRunTab, peerOf } = await import('../src/services/tabManager.js')

function fakeDb(rows) {
  return () => {
    const q = { orderBy: () => q, first: async () => rows[0] || null }
    return q
  }
}

function fakeBrowser() {
  const main = { id: undefined, name: 'main' }
  const pages = []
  const spaces = [main]
  const page = (url, space, { front = false } = {}) => {
    const p = {
      url: () => url, isClosed: () => false, browserContext: () => space,
      evaluate: async (fn) => {
        const s = String(fn)
        if (s.includes('visibilityState')) return { name: '', front, touched: 0, typed: false }
        return null
      },
      evaluateOnNewDocument: async () => {}, on: () => {}, setRequestInterception: async () => {},
      target: () => ({ createCDPSession: async () => ({ send: async () => ({}), on: () => {} }) }),
      bringToFront: async () => {},
    }
    pages.push(p)
    return p
  }
  const b = {
    pages: async () => pages,
    defaultBrowserContext: () => main,
    browserContexts: () => spaces,
    targets: () => [],
    createBrowserContext: async () => { const s = { id: `space-${spaces.length}`, newPage: async () => page('about:blank', s) }; spaces.push(s); return s },
    newPage: async () => page('about:blank', main),
  }
  main.newPage = b.newPage
  return { b, page, main }
}

test('the main account stays in the browser\'s own space, another gets its own', async () => {
  const { b } = fakeBrowser()
  const db = fakeDb([{ id: 3 }])
  assert.equal(await spaceForAccount(db, b, 'musaned', 3), null)
  const other = await spaceForAccount(db, b, 'musaned', 9)
  assert.ok(other?.id)
  // The same account finds its space again.
  assert.equal(await spaceForAccount(db, b, 'musaned', 9), other)
  assert.equal(await spaceForAccount(db, b, 'tasheer', 9), null)   // Tasheer: one sign-in for the agency
  assert.equal(peerOf('musaned_upload_cv'), 'musaned')
  assert.equal(peerOf('police_clearance'), 'lmis')
})

test('a run takes the signed-in tab behind, never the one a person is on', async () => {
  const { b, page, main } = fakeBrowser()
  const behind = page('https://visa.mofa.gov.sa/Enjaz/Main', main)
  assert.equal(await openRunTab(b, 9001, { workflowId: 'mofa_visa', busyRuns: new Set() }), behind)
  const { b: b2, page: page2, main: main2 } = fakeBrowser()
  const front = page2('https://visa.mofa.gov.sa/Enjaz/Main', main2, { front: true })
  const got = await openRunTab(b2, 9003, { workflowId: 'mofa_visa', busyRuns: new Set() })
  assert.notEqual(got, front)
  assert.equal(got.url(), 'about:blank')
})

test('a run of another account never takes the main account\'s tab', async () => {
  const { b, page, main } = fakeBrowser()
  page('https://tawtheeq.musaned.com.sa/dashboard', main)
  const space = await b.createBrowserContext()
  const got = await openRunTab(b, 9002, { workflowId: 'musaned_upload_cv', busyRuns: new Set(), space })
  assert.equal(got.browserContext(), space)
  assert.equal(got.url(), 'about:blank')
})
