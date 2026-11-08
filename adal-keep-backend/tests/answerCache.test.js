import test from 'node:test'
import assert from 'node:assert/strict'

test('a kept list is answered from memory, and made again the moment its table changes', async () => {
  const { default: express } = await import('express')
  const { default: knex } = await import('knex')
  const { answerCache } = await import('../src/services/answerCache.js')
  const { watchChanges } = await import('../src/services/changes.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db('profiles').insert({ full_name: 'A' })
  watchChanges(db)
  let made = 0
  const app = express()
  app.use(answerCache())
  app.get('/api/profiles', async (req, res) => { made++; res.json(await db('profiles').select('*')) })
  const server = app.listen(0)
  const url = `http://127.0.0.1:${server.address().port}/api/profiles`
  const names = async () => (await (await fetch(url)).json()).map(p => p.full_name)

  assert.deepEqual(await names(), ['A'])
  assert.deepEqual(await names(), ['A'])
  assert.equal(made, 1)                                  // the second came from memory
  await db('profiles').insert({ full_name: 'B' })
  await new Promise(r => setTimeout(r, 900))             // the change is told within a second
  assert.deepEqual(await names(), ['A', 'B'])
  assert.equal(made, 2)
  assert.equal((await (await fetch(url + '?q=A')).json()).length, 2)
  assert.equal(made, 3)                                  // a search is always fresh
  server.close()
  await db.destroy()
})
