/** The CV step is done when nothing is lacking (no PDF), and Musaned then asks nothing again. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import knex from 'knex'

const { cvLacks, lacksOf, isComplete, completeIds } = await import('../src/services/cvComplete.js')
const { musanedMissing } = await import('../src/services/musanedPreflight.js')
const { journeyOf, stepNow } = await import('../src/routes/automations.js')

const FULL = { id: 1, broker_id: 2, religion: 'Muslim', marital_status: 'SINGLE', phone_number: '0912345678', full_name: 'HANNA A', first_name: 'HANNA', last_name: 'A', passport_number: 'EP1', date_of_birth: '2000-01-01', place_of_birth: 'JIMMA', nationality: 'ETHIOPIAN', gender: 'Female', children_count: 0, weight: '55', height: '160' }
const DOCS = new Set(['Photo', 'Full Body Photo', 'Passport'])

test('complete: nothing lacking; each missing thing is named; a Musaned need is never outside it', () => {
  assert.deepEqual(cvLacks(FULL, DOCS), [])
  for (const k of ['broker_id', 'religion', 'marital_status', 'phone_number', 'weight', 'passport_number', 'place_of_birth']) assert.equal(cvLacks({ ...FULL, [k]: '' }, DOCS).length, 1, k)
  assert.equal(cvLacks({ ...FULL, phone_number: '123' }, DOCS).length, 1)
  assert.deepEqual(cvLacks({ ...FULL, place_of_birth: '', living_town: 'JIMMA' }, DOCS), [])
  for (const d of DOCS) assert.equal(cvLacks(FULL, new Set([...DOCS].filter(x => x !== d))).length, 1, d)
  assert.match(cvLacks(FULL, new Set(['Photo (passport crop)', 'Full Body Photo', 'Passport']))[0], /personal photo/)
  // Whatever Musaned would miss, the CV lacks too.
  for (const patch of [{}, { religion: '' }, { marital_status: null }, { phone_number: '' }]) {
    const p = { ...FULL, ...patch }
    if (!cvLacks(p, DOCS).length) assert.deepEqual(musanedMissing(p, true), [])
  }
})

async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { for (const k of Object.keys(FULL)) if (k !== 'id') t.string(k); t.increments('id'); t.string('living_town') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('mimetype'); t.integer('size') })
  for (const id of [1, 2]) await db('profiles').insert({ ...FULL, id, children_count: '0' })
  let n = 0
  for (const id of [1, 2]) for (const name of DOCS) { const [f] = await db('profile_fields').insert({ profile_id: id, name }); await db('files').insert({ profile_field_id: f, path: `x${++n}.jpg`, mimetype: 'image/jpeg' }) }
  return db
}

test('from her rows only (no file on this disk): one girl and the list say the same; off and errors: as before', async () => {
  const db = await makeDb()
  assert.equal(await isComplete(db, 1), true)
  assert.deepEqual([...await completeIds(db, await db('profiles'))], [1, 2])
  await db('profiles').where('id', 2).update({ weight: null })
  assert.deepEqual([...await completeIds(db, await db('profiles'))], [1])
  assert.deepEqual(await lacksOf(db, 2), ['weight'])
  // Only the passport's face on file.
  await db('files').where('path', 'x1.jpg').update({ path: 'p_photo.jpg' })
  assert.equal(await isComplete(db, 1), false)
  process.env.ADAL_CV_READY = '0'
  assert.equal(await lacksOf(db, 1), null); assert.equal(await isComplete(db, 1), false); assert.equal((await completeIds(db, await db('profiles'))).size, 0)
  delete process.env.ADAL_CV_READY
  assert.equal(await lacksOf(() => { throw new Error('x') }, 1), null)
  await db.destroy()
})

test('the journey: complete counts as the CV done, Musaned is the next step; incomplete stays at the CV', () => {
  const j = journeyOf({}, {}, 'ready')
  assert.deepEqual([j.embassy[0].state, j.embassy[0].note], ['done', 'all there'])
  assert.equal(stepNow({}, j).key, 'musaned')
  assert.equal(stepNow({}, journeyOf({}, {}, false)).key, 'cv')
  assert.equal(journeyOf({}, {}, true).embassy[0].note, 'made')
})

test('Musaned asks nothing again when complete; when the CV step was skipped it does ask', async () => {
  const db = await makeDb()
  const { default: router } = await import('../src/routes/automations.js')
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason') })
  await db.schema.createTable('generated_cvs', t => { t.increments('id'); t.integer('profile_id') })
  const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api', router)
  const server = http.createServer(app).listen(0)
  const needs = async (id) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/profiles/${id}/automations/musaned_add_candidate/needs`); return [r.status, await r.json()] }
  try {
    const [s, j] = await needs(1)
    assert.deepEqual([s, j], [200, { ok: true, missing: [] }])
    await db('generated_cvs').insert({ profile_id: 2 })
    await db('profiles').where('id', 2).update({ religion: '' })
    const [s2, j2] = await needs(2)
    assert.equal(s2, 400, JSON.stringify(j2)); assert.match(JSON.stringify(j2), /religion/)
  } finally { server.close(); await db.destroy() }
})
