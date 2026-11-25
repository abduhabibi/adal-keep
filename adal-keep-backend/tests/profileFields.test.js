/** profileFields.test.js — her document fields in a few reads (was two per template), the same answer as before. */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import { profileFields, HIDDEN_FIELDS } from '../src/services/profileFields.js'

// The route as it was until 2026-11-25 (one read per template and one for its files).
async function before(database, id) {
  const templates = await database('field_templates').where('is_permanent', true).orderBy('id')
  const result = []
  for (const template of templates) {
    const hidden = HIDDEN_FIELDS.has(template.name)
    const copies = await database('profile_fields').where('profile_id', id).andWhere('name', template.name).orderBy('id')
    const field = copies[0]
    if (!field) continue
    const files = await database('files').whereIn('profile_field_id', copies.map(c => c.id)).select('id', 'original_name', 'path', 'mimetype', 'size')
    if (hidden && !files.length) continue
    result.push({ ...field, files })
  }
  return result
}

async function fresh() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name'); t.string('data_type'); t.boolean('is_permanent'); t.timestamps() })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.boolean('is_permanent'); t.text('value_text') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size') })
  for (const name of ['Passport', 'Slip', 'COC', 'Broker ID', 'CV']) await db('field_templates').insert({ name, data_type: 'file', is_permanent: true })
  return db
}
const file = (profile_field_id, original_name) => ({ profile_field_id, original_name, path: `uploads/${original_name}`, mimetype: 'image/jpeg', size: 9 })

test('the first opening makes her rows; the answer is the same as before', async () => {
  const db = await fresh()
  const first = await profileFields(db, '7')
  assert.deepEqual(first.map(f => f.name), ['Passport', 'Slip', 'CV', 'Photo', 'Self Video'])   // the unused ones are not made
  assert.ok(first.every(f => f.id && Array.isArray(f.files) && !f.files.length))
  const again = await profileFields(db, '7')
  assert.deepEqual(again.map(f => f.id), first.map(f => f.id))
  assert.equal((await db('profile_fields')).length, 5)
  assert.deepEqual(again, await before(db, '7'))
  await db.destroy()
})

test('a field held twice shows the files of both; another girl\'s are not hers; a hidden one only with a file', async () => {
  const db = await fresh()
  await profileFields(db, 7); await profileFields(db, 8)
  const pass = await db('profile_fields').where({ profile_id: 7, name: 'Passport' }).first('id')
  const [copy] = await db('profile_fields').insert({ profile_id: 7, name: 'Passport', data_type: 'file', is_permanent: true })
  const [coc] = await db('profile_fields').insert({ profile_id: 7, name: 'COC', data_type: 'file', is_permanent: true })
  await db('profile_fields').insert({ profile_id: 7, name: 'Broker ID', data_type: 'file', is_permanent: true })
  const other = await db('profile_fields').where({ profile_id: 8, name: 'Passport' }).first('id')
  await db('files').insert([file(copy, 'a.jpg'), file(pass.id, 'b.jpg'), file(coc, 'coc.jpg'), file(other.id, 'x.jpg')])
  const now = await profileFields(db, 7)
  const of = (n) => now.find(f => f.name === n)
  assert.equal(of('Passport').id, pass.id)
  assert.deepEqual(of('Passport').files.map(f => f.original_name), ['a.jpg', 'b.jpg'])
  assert.deepEqual(Object.keys(of('Passport').files[0]), ['id', 'original_name', 'path', 'mimetype', 'size'])
  assert.deepEqual(of('COC').files.map(f => f.original_name), ['coc.jpg'])
  assert.equal(of('Broker ID'), undefined)
  assert.deepEqual(now, await before(db, 7))
  await db.destroy()
})

test('opening her again costs three reads, whatever the number of fields', async () => {
  const db = await fresh()
  for (let i = 0; i < 25; i++) await db('field_templates').insert({ name: 'Extra ' + i, data_type: 'file', is_permanent: true })
  await profileFields(db, 7)
  let n = 0
  db.on('query', () => n++)
  await profileFields(db, 7)
  assert.equal(n, 3)
  await db.destroy()
})
