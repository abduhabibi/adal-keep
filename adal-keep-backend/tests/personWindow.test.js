/**
 * personWindow.test.js — the owner, 2026-11-24: "yes build it". On a Windows agency PC, while a run waits for a
 * person (captcha, code, tick), the robot's own window comes on the screen and in front; when the step is over,
 * or after 10 minutes, it goes back out of sight. Never on Linux (headless: the live view is the way in).
 * A fake tab records what is asked of its window (no browser, no window).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.JEV_ENABLED = 'false'
process.env.HOME = (await import('fs')).mkdtempSync((await import('path')).join((await import('os')).tmpdir(), 'pw-home-'))
const B = await import('../src/services/browser.js')
const { showWhileWaiting } = await import('../src/services/worker.js')
const A = await import('../src/services/attention.js')

function fakeTab() {
  const calls = []
  const cdp = { send: async (m, p) => { calls.push([m, p?.bounds]); return m === 'Browser.getWindowForTarget' ? { windowId: 3, bounds: {} } : {} } }
  return { calls, page: { __adalCdp: cdp, isClosed: () => false, browser: () => ({}) } }
}

test('where the window comes: Windows with hidden agents only', () => {
  assert.equal(B.showsWindowHere({ platform: 'win32', hidden: true, headless: false }), true)
  assert.equal(B.showsWindowHere({ platform: 'linux', hidden: true, headless: true }), false)
  assert.equal(B.showsWindowHere({ platform: 'win32', hidden: false, headless: false }), false)   // already on the screen
})

test('on the screen and in front for the step, out of sight again after it', async () => {
  const { calls, page } = fakeTab()
  assert.equal(await B.showForPerson(page, { force: true }), true)
  assert.ok(calls.some(([m, b]) => m === 'Browser.setWindowBounds' && b?.windowState === 'maximized'))
  assert.ok(calls.some(([m]) => m === 'Page.bringToFront'))
  calls.length = 0
  assert.equal(await B.hideFromPerson(page), true)
  assert.ok(calls.some(([m, b]) => m === 'Browser.setWindowBounds' && b?.left === -32000))
  assert.equal(await B.hideFromPerson(page), false)   // only once, only a window it brought
})

test('after 10 minutes it goes back by itself', async () => {
  const { calls, page } = fakeTab()
  await B.showForPerson(page, { force: true, ms: 50 })
  calls.length = 0
  await new Promise(r => setTimeout(r, 120))
  assert.ok(calls.some(([m, b]) => m === 'Browser.setWindowBounds' && b?.left === -32000))
})

test('the step answered: the window goes back', async () => {
  const { calls, page } = fakeTab()
  const Bf = { ...B, showForPerson: (p) => B.showForPerson(p, { force: true }) }
  A.needPerson(42, 'tick "I\'m not a robot" on Musaned')
  assert.equal(await showWhileWaiting(42, page, { B: Bf, A }), true)
  calls.length = 0
  A.doneWith(42, { force: true })
  await new Promise(r => setTimeout(r, 50))
  assert.ok(calls.some(([m, b]) => m === 'Browser.setWindowBounds' && b?.left === -32000))
})

test('on Linux nothing comes on the screen', async () => {
  const { calls, page } = fakeTab()
  if (process.platform === 'linux') {
    assert.equal(await B.showForPerson(page), false)
    assert.equal(calls.length, 0)
  }
})
