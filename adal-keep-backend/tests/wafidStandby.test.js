/**
 * wafidStandby.test.js — the owner, 2026-11-24: "keep the wafid stand by to make things faster, cuz wafid
 * doesn't need login". One Wafid tab ready on its page; a run on it starts with no page load; the tab is loaded
 * again only when stale (30 min) or broken, never while a run or a person uses it. No browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.JEV_ENABLED = 'false'
const { standbyStep, WAFID_STANDBY } = await import('../src/services/sessionKeeper.js')
const { toPage } = await import('../src/services/wafidWorkflow.js')

test('the standby tab: opened, kept, loaded again only when needed', () => {
  const now = Date.now()
  assert.equal(standbyStep(null, now), 'open')
  assert.equal(standbyStep({ url: WAFID_STANDBY, loadedAt: now - 60e3 }, now), 'ok')
  assert.equal(standbyStep({ url: WAFID_STANDBY, loadedAt: now - 31 * 60e3 }, now), 'load')        // stale
  assert.equal(standbyStep({ url: WAFID_STANDBY, loadedAt: now, broken: true }, now), 'load')       // an error page
  assert.equal(standbyStep({ url: 'https://wafid.com/en/appointment/x/slip/print/', loadedAt: now }, now), 'load')   // after a run
  assert.equal(standbyStep({ url: 'https://wafid.com/en/appointment/x/', busy: true }, now), 'ok')   // a run in it
  assert.equal(standbyStep({ url: WAFID_STANDBY, typed: true, loadedAt: 0 }, now), 'ok')            // a person typing
})

function fakePage(url, { at = Date.now(), typed = false } = {}) {
  const loads = []
  return { loads, __adalStandbyAt: at, url: () => url, evaluate: async () => !typed, goto: async (u) => { loads.push(u); url = u } }
}

test('a run on the ready tab starts with no page load; otherwise the page loads', async () => {
  const ready = fakePage(WAFID_STANDBY)
  assert.equal(await toPage(ready, WAFID_STANDBY), 'ready')
  assert.deepEqual(ready.loads, [])
  const other = fakePage(WAFID_STANDBY)
  assert.equal(await toPage(other, 'https://wafid.com/en/medical-status-search/'), 'loaded')
  const stale = fakePage(WAFID_STANDBY, { at: Date.now() - 40 * 60e3 })
  assert.equal(await toPage(stale, WAFID_STANDBY), 'loaded')
  const typedIn = fakePage(WAFID_STANDBY, { typed: true })
  assert.equal(await toPage(typedIn, WAFID_STANDBY), 'loaded')
})

test("a site's tabs no run needs any more are closed; one signed-in tab stays; forms and people's tabs never", async () => {
  const { spareTabs } = await import('../src/services/sessionKeeper.js')
  const form = { owned: true, signedIn: true }, login = { signedIn: false }, done1 = { signedIn: true }, done2 = { signedIn: true }
  const typed = { signedIn: true, typed: true }, person = { signedIn: false, borrowed: true }
  // A run's form waits for Save (signed in): the finished runs' tabs and the stray /login tab go.
  assert.deepEqual(spareTabs([form, login, done1, done2, typed, person]), [login, done1, done2])
  // No run holds a signed-in tab: one free signed-in tab stays for the next run.
  assert.deepEqual(spareTabs([login, done1, done2]), [login, done2])
  // Nothing signed in: nothing closed (the sign-in may be in progress there).
  assert.deepEqual(spareTabs([login, { signedIn: false }]), [])
})
