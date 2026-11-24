import test from 'node:test'
import assert from 'node:assert/strict'

// The window reloads itself at most once a minute (asked on 2026-11-24: "the CV preview
// keeps reloading and getting blank" — a page file missing made it reload ~3 times a
// second, forever). Checked headless too: 81 reloads in 30 s before, 1 after, then the error.
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }
globalThis.localStorage = store()
globalThis.sessionStorage = store()
let reloads = 0
globalThis.window = { location: { reload: () => { reloads++ } } }
const { reloadOnce, mayReload, lazyOrNothing } = await import('../../adal-keep-frontend/src/lib/reloadGuard.js')

test('once, then not again within a minute; again after it', () => {
  assert.equal(reloadOnce('a page file did not load'), true)
  assert.equal(reloads, 1)
  for (let i = 0; i < 50; i++) assert.equal(reloadOnce('again'), false)
  assert.equal(reloads, 1)
  const at = Number(localStorage.getItem('adal-auto-reload-at'))
  assert.equal(mayReload(60_000, at + 59_000), false)
  assert.equal(mayReload(60_000, at + 61_000), true)
  assert.equal(mayReload(10 * 60_000, at + 61_000), false)   // a version change: once in 10 minutes
})

test('a lazy part whose file does not load: nothing shown (never a blank page), no loop', async () => {
  const before = reloads
  const load = lazyOrNothing(() => Promise.reject(new Error('Failed to fetch dynamically imported module')), 'test')
  const m = await load()
  assert.equal(typeof m.default, 'function')
  assert.equal(m.default(), null)
  assert.equal(reloads, before)
})
