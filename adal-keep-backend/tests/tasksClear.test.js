import test from 'node:test'
import assert from 'node:assert/strict'

test('"Remove all" (POST /tasks/clear) removes every listed task and keeps them gone', async () => {
  const { default: knex } = await import('knex')
  const { default: express } = await import('express')
  const { default: router } = await import('../src/routes/tasks.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('tasks', t => { t.increments('id'); t.string('title'); t.string('status'); t.string('created_at') })
  await db.schema.createTable('trash', t => {
    t.increments('id'); t.string('kind'); t.integer('item_id'); t.string('title'); t.text('payload'); t.text('files')
    t.string('deleted_by'); t.string('deleted_from'); t.string('deleted_at')
  })
  for (let i = 1; i <= 5; i++) await db('tasks').insert({ title: `t${i}`, status: i % 2 ? 'pending' : 'completed' })
  const app = express(); app.use(express.json()); app.locals.db = db; app.use('/tasks', router)
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/tasks`
  try {
    const r = await fetch(`${base}/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [1, 2, 3, 4, 5] }) })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).removed, 5)
    assert.deepEqual(await (await fetch(base)).json(), [])
    assert.equal((await db('trash').count({ n: '*' }).first()).n, 5)
    // asking again changes nothing and fails nothing
    const again = await fetch(`${base}/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [1, 2] }) })
    assert.equal(again.status, 200)
  } finally { srv.close(); await db.destroy() }
})
