/** The "Her CV" pop-up: children 0 unless written, the agency's mobile shown for a girl with none, the broker found while typing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import knex from 'knex'

const { withChildren, fillChildren } = await import('../src/services/childrenCount.js')
const { cvLacks } = await import('../src/services/cvComplete.js')
const page = await import('../../adal-keep-frontend/src/lib/childrenCount.js')
const { missingNow } = await import('../../adal-keep-frontend/src/lib/missingNow.js')
const { searchBrokers, brokerKey } = await import('../../adal-keep-frontend/src/lib/brokerSearch.js')
const { mobileShown, mobileToSave } = await import('../../adal-keep-frontend/src/lib/popupMobile.js')
const { default: routes } = await import('../src/routes/stepPopup.js')

const GIRL = { broker_id: 2, religion: 'Muslim', marital_status: 'SINGLE', phone_number: '0912345678', full_name: 'A', first_name: 'A', last_name: 'B', passport_number: 'EP1', date_of_birth: '2000-01-01', place_of_birth: 'JIMMA', nationality: 'ETHIOPIAN', gender: 'Female', weight: '55', height: '160' }
const DOCS = new Set(['Photo', 'Full Body Photo', 'Passport'])

test('children: never lacking (empty, 0 or a number); saved as 0 only when empty; her number is kept', () => {
  for (const children_count of [undefined, null, '', 0, '0', 3]) assert.deepEqual(cvLacks({ ...GIRL, children_count }, DOCS), [], String(children_count))
  // A new girl, and the next save of an old one.
  assert.equal(withChildren({}).children_count, 0)
  assert.equal(withChildren({ children_count: '' }).children_count, 0)
  assert.equal(withChildren({ weight: '50' }, { children_count: null }).children_count, 0)
  // A girl with a number, or 0 as a real value.
  assert.deepEqual(withChildren({ weight: '50' }, { children_count: 2 }), { weight: '50' })
  assert.deepEqual(withChildren({ weight: '50' }, { children_count: 0 }), { weight: '50' })
  assert.deepEqual(withChildren({ children_count: '' }, { children_count: 2 }), {}, 'a blank never takes her number away')
  assert.deepEqual(withChildren({ children_count: 0 }, { children_count: 2 }), { children_count: 0 }, 'a person set 0')
  assert.deepEqual(withChildren({ children_count: 4 }, { children_count: null }), { children_count: 4 })
  // Shown.
  assert.equal(fillChildren({ children_count: null }).children_count, 0); assert.equal(fillChildren({ children_count: 2 }).children_count, 2); assert.equal(fillChildren({ children_count: 0 }).children_count, 0)
  assert.deepEqual(fillChildren({ id: 1 }), { id: 1 })
  for (const [v, want] of [[null, 0], ['', 0], [undefined, 0], [0, 0], ['0', 0], ['3', 3]]) assert.equal(page.childrenOrZero(v), want)
  assert.ok(!missingNow({ id: 1, children_count: null }, [], 'cv').texts.some(t => t.key === 'children_count'))
  process.env.ADAL_CHILDREN_ZERO = '0'
  assert.deepEqual(withChildren({}), {}); assert.equal(fillChildren({ children_count: null }).children_count, null)
  delete process.env.ADAL_CHILDREN_ZERO
})

test('children on the CV: 0 when none is written, her number or her contract\'s kept; the PC and the page the same', async () => {
  const { buildTemplateData } = await import('../src/services/cvRender.js')
  const { cvData } = await import('../../adal-keep-frontend/src/lib/cvLocal.js')
  const q = { join: () => q, where: () => q, andWhere: () => q, select: () => q, orderBy: () => q, first: async () => null, then: (r) => r([]) }
  const tpl = { salary: 1000, currency: 'SAR', include_passport: 0, html_content: '<html><head></head><body>{{CHILDREN_COUNT}}</body></html>', css_content: '' }
  const contract = JSON.stringify({ 'Number Of Children': '2' })
  for (const [g, want] of [[{ children_count: null }, '0'], [{ children_count: '' }, '0'], [{ children_count: 0 }, '0'], [{ children_count: 3 }, '3'], [{ children_count: null, contract_data: contract }, '2'], [{ children_count: 0, contract_data: contract }, '0']]) {
    const p = { id: 7, full_name: 'A', ...g }
    assert.equal(String((await buildTemplateData(() => q, p, tpl, {})).CHILDREN_COUNT), want, JSON.stringify(g)); assert.equal(String((await cvData(p, tpl, {})).CHILDREN_COUNT), want, JSON.stringify(g))
  }
  assert.equal(withChildren({ weight: '50' }, { children_count: null, contract_data: contract }).children_count, 2)
  assert.equal(fillChildren({ children_count: null, contract_data: contract }).children_count, 2)
  assert.equal(withChildren({ weight: '50' }, { children_count: null, contract_data: 'broken{' }).children_count, 0)
})

test('mobile: the agency\'s number is shown for an empty girl only, saved only with the form, never over hers', () => {
  const saved = '0911223344'
  assert.deepEqual(mobileShown({ hers: '', saved }), { value: saved, from: 'agency' })
  assert.deepEqual(mobileShown({ hers: null, saved: '' }), { value: '', from: '' })
  assert.deepEqual(mobileShown({ hers: '0987654321', saved }), { value: '0987654321', from: 'hers' })
  assert.deepEqual(mobileShown({ hers: '12', saved }), { value: '12', from: 'hers' }, 'a wrong number is hers to mend, not replaced')
  assert.deepEqual(mobileShown({ typed: '', hers: '', saved }), { value: '', from: 'typed' }, 'emptied by the person: stays empty')
  assert.equal(mobileToSave({ hers: '', saved }), saved)
  assert.equal(mobileToSave({ hers: '', saved }, '0987654321'), undefined, 'she got one meanwhile on another PC')
  assert.equal(mobileToSave({ hers: '0987654321', saved }), undefined)
  assert.equal(mobileToSave({ typed: '0900000001', hers: '', saved }), '0900000001', 'another one for this girl')
  assert.equal(mobileToSave({ typed: '', hers: '', saved }), undefined)
})

test('mobile: one setting for the agency; a bad number is refused; girls\' numbers are not touched; off', async () => {
  const db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('settings', t => { t.string('key'); t.string('value') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('phone_number') })
  await db('profiles').insert([{ phone_number: '' }, { phone_number: '0987654321' }])
  const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api', routes)
  const server = http.createServer(app).listen(0); const base = `http://127.0.0.1:${server.address().port}/api/settings/step-popup`
  const get = async () => (await fetch(base)).json()
  const put = async (mobile) => { const r = await fetch(`${base}/mobile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile }) }); return [r.status, await r.json()] }
  try {
    assert.deepEqual(await get(), { mobile: '', broker_search: true })
    assert.equal((await put('12345'))[0], 400)
    assert.deepEqual(await put('+251 911 22 33 44'), [200, { mobile: '0911223344' }])
    assert.deepEqual(await put('0922334455'), [200, { mobile: '0922334455' }])
    assert.equal((await db('settings')).length, 1); assert.equal((await get()).mobile, '0922334455')
    assert.deepEqual((await db('profiles')).map(p => p.phone_number), ['', '0987654321'])
    assert.deepEqual(await put(''), [200, { mobile: '' }])
    process.env.ADAL_BROKER_SEARCH = '0'; assert.equal((await get()).broker_search, false); delete process.env.ADAL_BROKER_SEARCH
    process.env.ADAL_STEP_POPUP = '0'; assert.equal((await fetch(base)).status, 404); assert.equal((await put('0911223344'))[0], 404); delete process.env.ADAL_STEP_POPUP
  } finally { server.close(); await db.destroy() }
})

const B = [{ id: 1, name: 'Ahmed Ali', contact1: '0911000001' }, { id: 2, name: 'Ahmed Alemu', contact1: '0911000002' }, { id: 3, name: 'Sara Ahmed' }, { id: 4, name: 'Mohammed', contact2: '+251 922 333 444' }, { id: -5, name: 'Ahmed not saved yet' }]
test('broker: two similar names, words in any order, a phone number, nothing found', () => {
  const ids = (q) => searchBrokers(B, q).map(b => b.id)
  assert.deepEqual(ids('ahmed al'), [2, 1], 'both similar ones, by name'); assert.deepEqual(ids('ahmed ali'), [1]); assert.deepEqual(ids('ALEMU'), [2])
  assert.deepEqual(ids('ahm'), [2, 1, 3], 'beginning with it first'); assert.deepEqual(ids('ali ahmed'), [1]); assert.deepEqual(ids('  áhmed   ali '), [1])
  assert.deepEqual(ids('0922333'), [4]); assert.deepEqual(ids('0911000002'), [2])
  assert.deepEqual(ids('zzz'), []); assert.equal(ids('').length, 4); assert.deepEqual(searchBrokers(null, 'a'), []); assert.equal(searchBrokers(Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: `A${i}` })), 'a', 30).length, 30)
})

test('broker: arrows move, Enter picks, Enter with nothing found makes and sends nothing, Escape closes the list only', () => {
  const found = searchBrokers(B, 'ahmed al')
  assert.equal(brokerKey('ArrowDown', { at: 0, open: true, found }).at, 1); assert.equal(brokerKey('ArrowDown', { at: 1, open: true, found }).at, 0); assert.equal(brokerKey('ArrowUp', { at: 0, open: true, found }).at, 1)
  assert.equal(brokerKey('Enter', { at: 1, open: true, found }).pick.id, 1)
  const none = brokerKey('Enter', { at: 0, open: true, found: [] }); assert.deepEqual([none.pick, none.stop], [null, true])
  assert.deepEqual(brokerKey('Escape', { open: true, found }), { open: false, at: 0, stop: true }); assert.equal(brokerKey('Escape', { open: false, found }).stop, false)
  assert.equal(brokerKey('a', {}), null)
})
