/**
 * cvFast.test.js — a CV download in about a second (the owner, 2026-11-27): her ready CV is
 * served again while nothing it is made of changed; any change makes it again; off with ADAL_CV_FAST=0.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-fast-'))
process.env.ADAL_CV_FAST_FILE = path.join(tmp, 'cv-fast.json')
const F = await import('../src/services/cvFast.js')
const dbs = []
test.after(async () => { for (const d of dbs) await d.destroy() })

async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  dbs.push(db)
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.integer('size'); t.string('original_name'); t.string('updated_at') })
  await db.schema.createTable('brokers', t => { t.increments('id'); t.string('name'); t.string('updated_at') })
  await db.schema.createTable('generated_cvs', t => { t.increments('id'); t.string('filename'); t.string('pdf_path') })
  await db('brokers').insert({ id: 3, name: 'Ali' })
  await db('profile_fields').insert([{ id: 1, profile_id: 7, name: 'Photo' }, { id: 2, profile_id: 7, name: 'CV' }])
  await db('files').insert({ id: 10, profile_field_id: 1, path: 'p.jpg', size: 4_000_000 })
  return db
}
const girl = { id: 7, full_name: 'Test Girl', religion: 'Muslim', broker_id: 3, updated_at: '2026-11-27T08:00:00Z', contract_data: '{"a":1}' }
const tpl = { id: 2, name: 'T', html_content: '<b>{{FULL_NAME}}</b>', header_path: 'h1.png', updated_at: 'x' }

test('the same girl, template and choices: the same key; a look or a sync time does not change it', async () => {
  const db = await makeDb()
  const k = await F.cvInputKey(db, girl, tpl, { salary: 1000 })
  assert.equal(await F.cvInputKey(db, { ...girl, updated_at: '2026-11-27T09:00:00Z' }, { ...tpl, updated_at: 'y' }, { salary: 1000 }), k)
})

test('anything the CV is made of changes the key', async () => {
  const db = await makeDb()
  const k = await F.cvInputKey(db, girl, tpl, {})
  assert.notEqual(await F.cvInputKey(db, { ...girl, religion: 'Christian' }, tpl, {}), k, 'her details')
  assert.notEqual(await F.cvInputKey(db, { ...girl, contract_data: '{"a":2}' }, tpl, {}), k, 'her contract')
  assert.notEqual(await F.cvInputKey(db, girl, { ...tpl, html_content: '<i>x</i>' }, {}), k, 'the template')
  assert.notEqual(await F.cvInputKey(db, girl, { ...tpl, header_path: 'h2.png' }, {}), k, 'a new header picture')
  assert.notEqual(await F.cvInputKey(db, girl, tpl, { salary: 900 }), k, 'the form')
  await db('files').insert({ id: 11, profile_field_id: 1, path: 'p2.jpg', size: 5_000_000 })
  assert.notEqual(await F.cvInputKey(db, girl, tpl, {}), k, 'a new photo')
  await db('files').where({ id: 11 }).del()
  await db('brokers').where({ id: 3 }).update({ name: 'Omar' })
  assert.notEqual(await F.cvInputKey(db, girl, tpl, {}), k, 'her broker')
  await db('brokers').where({ id: 3 }).update({ name: 'Ali' })
  assert.equal(await F.cvInputKey(db, girl, tpl, {}), k, 'all back: the same key')
  await db('files').insert({ id: 12, profile_field_id: 2, path: 'old-cv.pdf', size: 1 })
  assert.equal(await F.cvInputKey(db, girl, tpl, {}), k, 'her CVs themselves are not what a CV is made of')
})

test('the ready CV is used while its rows and file are there; gone → made again; off → never', async () => {
  F._resetMap()
  const db = await makeDb()
  const pdf = path.join(tmp, 'AdalCV_7.pdf'); fs.writeFileSync(pdf, 'x'.repeat(5000))
  await db('generated_cvs').insert({ id: 5, filename: 'AdalCV_7.pdf', pdf_path: 'AdalCV_7.pdf' })
  await db('files').insert({ id: 20, profile_field_id: 2, path: 'AdalCV_7.pdf', size: 5000, original_name: 'Test_Girl_T.pdf' })
  const resolve = (f) => path.join(tmp, f.path)
  F.rememberCv('k1', { generated_cv_id: 5, file_id: 20 })
  const r = await F.readyCv(db, 'k1', resolve)
  assert.equal(r.file_id, 20); assert.equal(r.generated_cv_id, 5); assert.equal(r.ready, true)
  assert.ok(JSON.parse(fs.readFileSync(process.env.ADAL_CV_FAST_FILE, 'utf8')).k1, 'kept on disk (after a restart too)')
  process.env.ADAL_CV_FAST = '0'
  try { assert.equal(await F.readyCv(db, 'k1', resolve), null) } finally { delete process.env.ADAL_CV_FAST }
  await db('generated_cvs').where({ id: 5 }).del()   // moved to the Trash
  assert.equal(await F.readyCv(db, 'k1', resolve), null)
  assert.equal(await F.readyCv(db, 'k1', resolve), null, 'forgotten')
  assert.equal(await F.readyCv(db, 'nothing', resolve), null)
})
