/** pageCode.test.js — a page's code that does not come is asked for again, under a new address, and never reloads the window. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

// (The file holds JSX: only its plain parts are run here.)
const src = fs.readFileSync(new URL('../../adal-keep-frontend/src/lib/pageCode.jsx', import.meta.url), 'utf8')
const part = src.slice(src.indexOf('const WAITS'), src.indexOf('const all = []')).replace(/export /g, '').replace(/again = \(url\) => import\([^)]*\)/, 'again')
const { persist, addressIn } = new Function('window', `${part}; return { persist, addressIn }`)({})
const gone = (u) => new TypeError(`Failed to fetch dynamically imported module: ${u}`)

test('the second time it comes: under another address, no reload', async () => {
  const asked = []
  const m = await persist(() => { throw gone('http://main:4000/assets/Profiles-a.js') }, { waits: [1, 1, 1], again: async (u) => { asked.push(u); if (asked.length < 2) throw gone(u); return { default: 'page' } } })
  assert.equal(m.default, 'page')
  assert.match(asked[0], /^http:\/\/main:4000\/assets\/Profiles-a\.js\?again=\d+$/)
  assert.match(asked[1], /^http:\/\/main:4000\/assets\/Profiles-a\.js\?again=\d+$/)
})

test('it never comes: said plainly after its tries; another kind of error is tried with the import itself', async () => {
  let n = 0
  await assert.rejects(persist(() => { throw gone('http://x/a.js') }, { waits: [1, 1], again: async (u) => { n++; throw gone(u) } }), (e) => e.pageCode === true && /Try again/.test(e.message))
  assert.equal(n, 2)
  let k = 0
  assert.equal(await persist(async () => { if (++k < 3) throw new Error('odd'); return 'ok' }, { waits: [1, 1, 1], again: () => assert.fail('no address to ask') }), 'ok')
  assert.equal(addressIn(new Error('nothing')), null)
})

test('no page of the window reloads by itself for its code', () => {
  for (const f of ['App.jsx', 'components/AttentionBar.jsx', 'components/BrowsersSection.jsx']) {
    const t = fs.readFileSync(new URL(`../../adal-keep-frontend/src/${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(t, /catch\([^)]*\) ?=> ?\{[^}]*location\.reload|if \(again\) \{ location\.reload/, f)
  }
})

test('the window never reloads or leaves by itself: only behind a click (or the off switch)', () => {
  const at = (f) => fs.readFileSync(new URL(`../../adal-keep-frontend/src/${f}`, import.meta.url), 'utf8')
  assert.match(at('components/UpdateBanner.jsx'), /if \(!updated \|\| !byItself\(\)\) return/)
  assert.match(at('components/UpdateBanner.jsx'), /if \(byItself\(\)\) location\.reload\(\); else setUpdated\(true\)/)
  assert.match(at('lib/companionOnline.js'), /if \(byItself\(\)\) \{ clearInterval\(t\); go\(\) \}/)
  assert.match(at('lib/companionDirect.js'), /if \(!windowUsed\(\) \|\| byItself\(\)\) go\(\)/)
  assert.match(at('components/PcAccessGate.jsx'), /if \(byItself\(\) \|\| !onIn\) location\.reload\(\); else onIn\(\)/)
  // Every reload of the window in the pages' code: after a person's press only (none on a timer but these, behind the switch).
  for (const f of ['components/UpdateBanner.jsx', 'components/PcAccessGate.jsx', 'lib/companionOnline.js', 'lib/companionDirect.js', 'App.jsx', 'context/AuthContext.jsx'])
    for (const line of at(f).split('\n').filter(l => /location\.reload\(|location\.replace\(/.test(l) && !/byItself|onClick|const go = /.test(l))) assert.match(line, /lastTouch\.current/, `${f}: ${line.trim()}`)
})
