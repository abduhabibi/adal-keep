// Adal Browser with nothing in it is quit after 10 minutes (2026-11-22: an idle one with a blank tab burned a weak PC's
// processor for an hour), and the keep-signed-in look never starts it.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.ADAL_NO_BROWSER_START = '1'
const { idleBrowser, IDLE_BROWSER_MS } = await import('../src/services/sessionKeeper.js')

test('blank tabs only, nothing running: quit after 10 minutes, not before', () => {
  const T = 1_000_000
  const first = idleBrowser(['about:blank'], 0, 0, T)
  assert.deepEqual(first, { quit: false, since: T })
  assert.equal(idleBrowser(['about:blank'], 0, first.since, T + 9 * 60000).quit, false)
  assert.equal(idleBrowser(['about:blank', 'chrome://newtab/'], 0, first.since, T + IDLE_BROWSER_MS).quit, true)
  assert.equal(IDLE_BROWSER_MS, 600000)
})

test('a site tab, a run, or no tabs at all that matter: never quit, the clock starts again', () => {
  assert.deepEqual(idleBrowser(['https://tawtheeq.musaned.com.sa/'], 0, 5, 9e9), { quit: false, since: 0 })
  assert.deepEqual(idleBrowser(['about:blank'], 1, 5, 9e9), { quit: false, since: 0 })
  assert.deepEqual(idleBrowser(['about:blank', 'https://lmis.gov.et/'], 0, 5, 9e9), { quit: false, since: 0 })
})
