import test from 'node:test'
import assert from 'node:assert/strict'

test('every write is noticed once, by table; bookkeeping is not', async () => {
  const { default: knex } = await import('knex')
  const { watchChanges, onChanged } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('notes') })
  await db.schema.createTable('activity_log', t => { t.increments('id'); t.string('x') })
  watchChanges(db)
  const heard = []
  const off = onChanged(c => heard.push(c.tables))
  await db('profiles').insert({ notes: 'a' })
  await db('profiles').where('id', 1).update({ notes: 'b' })
  await db('activity_log').insert({ x: 'quiet' })
  await db('profiles').select('*')               // reads are not changes
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [['profiles']])         // three writes, one message
  await db('profiles').where('id', 1).del()
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard[1], ['profiles'])
  off()
  await db.destroy()
})

test('opening a profile is not told to everyone (only its last_opened_at changes)', async () => {
  const { default: knex } = await import('knex')
  const { watchChanges, onChanged } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('notes'); t.string('last_opened_at') })
  await db('profiles').insert({ notes: 'a' })
  watchChanges(db)
  const heard = []
  const off = onChanged(c => heard.push(c.tables))
  await new Promise(r => setTimeout(r, 900)); heard.length = 0
  await db('profiles').where('id', 1).update({ last_opened_at: new Date().toISOString() })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [])
  await db('profiles').where('id', 1).update({ notes: 'b' })
  await new Promise(r => setTimeout(r, 900))
  assert.deepEqual(heard, [['profiles']])
  off(); await db.destroy()
})
