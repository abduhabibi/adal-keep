// Languages: English (default, always), Amharic, Arabic (right to left), per employee; government terms stay.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'adal-keep-frontend', 'src', 'lib')
const store = {}
globalThis.window = { location: { reload() { store.reloaded = (store.reloaded || 0) + 1 } } }
globalThis.localStorage = { getItem: k => (k in store.ls ? store.ls[k] : null), setItem: (k, v) => { store.ls[k] = String(v) }, removeItem: k => { delete store.ls[k] } }
const fresh = () => { store.ls = {}; store.reloaded = 0 }
const I = () => import(`${LIB}/i18n.js`)
const asEmployee = (id) => { store.ls.adal_active_employee = JSON.stringify({ id }) }
const ARABIC = /[؀-ۿ]/, ETHIOPIC = /[ሀ-፿]/

test('English is the default, whatever is stored', async () => {
  const m = await I(); fresh()
  assert.equal(m.getLang(), 'en')
  store.ls['adal-lang-v2'] = 'klingon'; assert.equal(m.getLang(), 'en')
  store.ls['adal-lang-v2'] = 'am'; assert.equal(m.getLang(), 'am')   // the PC's own choice
})

test('each employee has their own language; another one still has English', async () => {
  const m = await I(); fresh()
  asEmployee(5); m.setLang('ar'); assert.equal(store.reloaded, 1); assert.equal(m.getLang(), 'ar')
  asEmployee(6); assert.equal(m.getLang(), 'en')
  m.setLang('am'); assert.equal(m.getLang(), 'am')
  asEmployee(5); assert.equal(m.getLang(), 'ar')
  delete store.ls.adal_active_employee; assert.equal(m.getLang(), 'en')   // nobody signed in: the PC's (English)
  m.setLang('zz'); assert.equal(m.getLang(), 'en')
})

test('switching employee reloads only when their language differs', async () => {
  const m = await I(); fresh(); asEmployee(1); store.ls['adal-lang-v3:1'] = 'ar'
  globalThis.document = { documentElement: { classList: { toggle() {} } }, body: {}, createTreeWalker: () => ({ nextNode: () => null }), title: '' }
  globalThis.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }; globalThis.MutationObserver = class { observe() {} }
  m.startLanguage()
  m.followUser(); assert.equal(store.reloaded, 0)
  asEmployee(2); m.followUser(); assert.equal(store.reloaded, 1)
})

test('Arabic turns the page right to left; English and Amharic do not', async () => {
  const m = await I()
  for (const [lang, dir] of [['ar', 'rtl'], ['am', 'ltr'], ['en', 'ltr']]) {
    fresh(); store.ls['adal-lang-v2'] = lang
    const root = { classList: { toggle() {} } }
    globalThis.document = { documentElement: root, body: {}, createTreeWalker: () => ({ nextNode: () => null }), title: '' }
    m.startLanguage()
    assert.equal(root.dir, dir); assert.equal(root.lang, lang)
  }
})

test('Amharic pages show in English; English labels show in Amharic and in Arabic', async () => {
  const m = await I()
  assert.equal(m.translateText('ዳሽቦርድ', 'en'), 'Dashboard')
  assert.equal(m.translateText('Dashboard', 'ar'), 'لوحة التحكم')
  assert.equal(m.translateText('ዳሽቦርድ', 'ar'), 'لوحة التحكم')            // Amharic -> English -> Arabic
  assert.equal(m.translateText('  Save ', 'ar').trim(), 'حفظ')
  assert.equal(m.translateText('Save', 'am'), 'አስቀምጥ')
  assert.equal(m.translateText('Cancel', 'am'), 'ተው')
  assert.equal(m.translateText('Save', 'en'), 'Save')
})

test('government terms stay as they are in every language', async () => {
  const m = await I()
  for (const term of ['Musaned', 'LMIS', 'EPRO', 'Wafid']) for (const l of ['en', 'am', 'ar']) assert.equal(m.translateText(term, l), term)
  assert.equal(m.translateText('ለሙሳነድ', 'am'), 'ለMusaned')
  assert.ok(m.translateText('Musaned authenticator', 'ar').includes('Musaned') || m.translateText('Musaned authenticator', 'ar') === 'Musaned authenticator')
  // no dictionary line turns a government term into another script
  const files = ['i18n.js', 'i18n/labels.js', 'i18n/ar-from-english.js'].map(f => fs.readFileSync(`${LIB}/${f}`, 'utf8')).join('\n')
  assert.ok(!/'(Musaned|LMIS|EPRO|Wafid)'\s*:/.test(files), 'a government term is a key in the Amharic map')
  assert.ok(!/\['(Musaned|LMIS|EPRO|Wafid)',/.test(files))
  const { LABELS } = await import(`${LIB}/i18n/labels.js`); const { AR_FROM_ENGLISH } = await import(`${LIB}/i18n/ar-from-english.js`)
  for (const row of [...LABELS, ...AR_FROM_ENGLISH]) if (/Musaned|LMIS|EPRO|Wafid/.test(row[0])) for (const v of row.slice(1)) if (v) assert.match(v, /Musaned|LMIS|EPRO|Wafid/, `${row[0]} lost its term`)
})

test('data a person typed is never translated (inside translate="no" the layer skips it) and unknown text stays', async () => {
  const m = await I()
  assert.equal(m.translateText('Almaz Tesfaye', 'ar'), 'Almaz Tesfaye')
  assert.equal(m.translateText('Some brand-new sentence nobody translated', 'ar'), 'Some brand-new sentence nobody translated')
  assert.equal(m.translateText('Name: Almaz', 'am'), 'Name: Almaz')       // only a whole label, never a part
  assert.equal(m.translateText('', 'ar'), '')
})

test('dictionaries are complete: every row has its languages, in the right script', async () => {
  const { LABELS } = await import(`${LIB}/i18n/labels.js`); const { AR_FROM_ENGLISH } = await import(`${LIB}/i18n/ar-from-english.js`)
  for (const [en, am, ar] of LABELS) {
    assert.ok(en && ar, en); assert.match(ar, ARABIC, `Arabic of "${en}"`)
    if (am !== null) { assert.match(am, ETHIOPIC, `Amharic of "${en}"`) }
  }
  for (const [en, ar] of AR_FROM_ENGLISH) { assert.ok(en); assert.match(ar, ARABIC, `Arabic of "${en}"`) }
  // the same English never has two different Arabic labels
  const seen = new Map()
  for (const [en, ar] of [...AR_FROM_ENGLISH, ...LABELS.map(l => [l[0], l[2]])]) { if (seen.has(en) && seen.get(en) !== ar) assert.fail(`"${en}" has two Arabic labels: ${seen.get(en)} / ${ar}`); seen.set(en, ar) }
})

test('every English phrase the Amharic pages turn into is also in Arabic (coverage)', async () => {
  const src = fs.readFileSync(`${LIB}/i18n.js`, 'utf8')
  const en = src.slice(src.indexOf('const EN = {'), src.indexOf('const ETHIOPIC'))
  const values = [...new Set([...en.matchAll(/'(?:[^'\\]|\\.)*'\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map(x => x[1] ?? x[2]))]
  const m = await I()
  const missing = values.filter(v => !ARABIC.test(m.translateText(v, 'ar')))
  const covered = 1 - missing.length / values.length
  console.log(`Arabic covers ${Math.round(covered * 100)}% of the ${values.length} English phrases`)
  assert.ok(covered >= 0.85, `only ${Math.round(covered * 100)}% covered; first missing: ${missing.slice(0, 15).join(' | ')}`)
})
