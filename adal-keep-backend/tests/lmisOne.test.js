// One LMIS per account (asked on 2026-11-20): a run goes where its account's LMIS is open already.
import test from 'node:test'
import assert from 'node:assert/strict'

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('lmis_accounts', t => { t.increments('id'); t.string('name'); t.string('phone'); t.boolean('is_default') })
  await db('lmis_accounts').insert([{ name: 'nuzla', phone: '0911000000', is_default: true }, { name: 'ZAD', phone: '0922000000', is_default: false }])
  return db
}
// A tab: its address and its browser space ('' = the browser's own).
const tab = (url, key) => {
  const own = {}, ctx = key ? {} : own
  return { url: () => url, key, browserContext: () => ctx, browser: () => ({ defaultBrowserContext: () => own }) }
}

test('the account open on a Companion: its runs go there; the main account open here: here', async () => {
  const db = await setup()
  const one = await import(`../src/services/lmisOne.js?t=${Math.random()}`)
  one._setForTest({
    spaceOf: (p) => p.key,
    browsers: async () => [
      { device: '', name: 'this PC', browser: { pages: async () => [tab('https://lmis.gov.et/new-agency/home', '')] } },
      { device: 'pc-2', name: 'Reception PC', browser: { pages: async () => [tab('https://lmis.gov.et/new-agency/home', 'lmis:2'), tab('https://musaned.com.sa/x', '')] } },
    ],
  })
  assert.deepEqual(await one.lmisHome(db, 2), { device: 'pc-2', name: 'Reception PC' })
  assert.deepEqual(await one.lmisHome(db, 1), { device: '', name: 'this PC' })
  assert.deepEqual(await one.lmisHome(db, null), { device: '', name: 'this PC' })   // no account: the main one
  assert.equal(await one.spaceKeyFor(db, 2), 'lmis:2')
  assert.equal((await one.accountOfPage(db, tab('https://lmis.gov.et/auth', 'lmis:2'), p => p.key)).name, 'ZAD')
  assert.equal((await one.accountOfPage(db, tab('https://lmis.gov.et/auth', ''), p => p.key)).name, 'nuzla')
  await db.destroy()
})

test('not open anywhere: no home (the run stays where it is)', async () => {
  const db = await setup()
  const one = await import(`../src/services/lmisOne.js?t=${Math.random()}`)
  one._setForTest({ spaceOf: (p) => p.key, browsers: async () => [{ device: '', name: 'this PC', browser: { pages: async () => [tab('https://lmis.gov.et/home', 'lmis:2')] } }] })
  assert.equal(await one.lmisHome(db, 1), null)
  await db.destroy()
})
