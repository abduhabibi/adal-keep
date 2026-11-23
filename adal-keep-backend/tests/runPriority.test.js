// Robot history → Waiting: a person moves a waiting run up or down the line or makes it run
// next; the worker starts the highest priority first, the oldest among equals; the order is
// plain data on automation_queue, so it is copied to every PC like the rest.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'

// (this PC's own licence file must not lock the worker in the test)
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'))

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db.schema.createTable('automation_queue', t => {
    t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status').defaultTo('pending')
    t.string('pause_reason'); t.string('started_at'); t.string('updated_at')
  })
  await (await import('../src/migrations/067_queue_priority.js')).up(db)
  await db('profiles').insert([{ full_name: 'Almaz' }, { full_name: 'Sara' }, { full_name: 'Hana' }])
  for (const pid of [1, 2, 3]) await db('automation_queue').insert({ profile_id: pid, workflow_id: 'musaned_add_candidate', status: 'pending' })
  return db
}
const W = () => import('../src/services/worker.js')
const P = () => import('../src/services/runPriority.js')
const order = async (db) => (await (await P()).waiting(db)).filter(r => r.status === 'pending').map(r => r.id)

test('the worker takes the oldest when nobody moved anything', async () => {
  const db = await setup(); const w = await W()
  assert.equal((await w.claimNextJob(db)).id, 1)
  assert.equal((await w.claimNextJob(db)).id, 2)
  await db.destroy()
})

test('run next: that run is claimed first; the rest keep their order', async () => {
  const db = await setup(); const p = await P(); const w = await W()
  await p.move(db, 3, 'next')
  assert.deepEqual(await order(db), [3, 1, 2])
  assert.equal((await w.claimNextJob(db)).id, 3)
  assert.equal((await w.claimNextJob(db)).id, 1)
  await db.destroy()
})

test('up and down move one place; the ends stay', async () => {
  const db = await setup(); const p = await P()
  await p.move(db, 2, 'up');   assert.deepEqual(await order(db), [2, 1, 3])
  await p.move(db, 2, 'up');   assert.deepEqual(await order(db), [2, 1, 3])
  await p.move(db, 2, 'down'); assert.deepEqual(await order(db), [1, 2, 3])
  await p.move(db, 3, 'up');   assert.deepEqual(await order(db), [1, 3, 2])
  await db.destroy()
})

test('how many wait ahead follows the priority', async () => {
  const db = await setup(); const p = await P(); const w = await W()
  assert.equal((await w.runStatus(db, 3)).ahead, 2)
  await p.move(db, 3, 'next')
  assert.equal((await w.runStatus(db, 3)).ahead, 0)
  assert.equal((await w.runStatus(db, 1)).ahead, 1)
  await db.destroy()
})

test('a paused run is out of the line and cannot be moved; running ones neither', async () => {
  const db = await setup(); const p = await P()
  await db('automation_queue').where('id', 2).update({ status: 'paused', pause_reason: 'Paused by user' })
  await db('automation_queue').where('id', 1).update({ status: 'running' })
  await assert.rejects(p.move(db, 2, 'next'), /not in the line/)
  await assert.rejects(p.move(db, 1, 'next'), /already working/)
  const all = await p.waiting(db)
  assert.deepEqual(all.map(r => [r.id, r.status, r.position]), [[3, 'pending', 1], [2, 'paused', null]])
  assert.equal(all[0].profile_name, 'Hana')
  await db.destroy()
})

test('the routes: list, run next, and a paused run is refused', async () => {
  const db = await setup()
  const app = express(); app.use(express.json()); app.locals.db = db
  app.use('/api', (await import('../src/routes/runPriority.js')).default)
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api`
  const j = async (path, method = 'GET') => { const r = await fetch(base + path, { method }); return { s: r.status, b: await r.json() } }
  assert.deepEqual((await j('/run-queue')).b.map(r => r.id), [1, 2, 3])
  const r = await j('/run-queue/3/next', 'POST')
  assert.equal(r.s, 200); assert.deepEqual(r.b.line.map(x => x.id), [3, 1, 2])
  await db('automation_queue').where('id', 2).update({ status: 'paused' })
  assert.equal((await j('/run-queue/2/up', 'POST')).s, 409)
  assert.equal((await j('/run-queue/99/up', 'POST')).s, 404)
  srv.close(); await db.destroy()
})

test('the order is plain data on the row, so the copy between PCs carries it', async () => {
  const db = await setup(); const p = await P()
  await p.move(db, 3, 'next')
  const rows = await db('automation_queue').orderBy('id').select('id', 'priority')
  assert.deepEqual(rows.map(r => r.priority), [2, 1, 3])
  // a PC that has not got the column yet still claims the oldest (no crash)
  const { default: knex } = await import('knex')
  const old = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await old.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('pause_reason'); t.string('updated_at'); t.string('started_at'); t.integer('profile_id'); t.string('workflow_id') })
  await old('automation_queue').insert([{ status: 'pending' }, { status: 'pending' }])
  assert.equal((await (await W()).claimNextJob(old)).id, 1)
  await old.destroy(); await db.destroy()
})

test('memory guard: quits the idle browser only when memory is short and no robot works', async () => {
  const { shouldQuit } = await import('../src/services/memoryGuard.js')
  assert.equal(shouldQuit({ freeMB: 200, rssMB: 300, working: 0 }), true)
  assert.equal(shouldQuit({ freeMB: 200, rssMB: 300, working: 1 }), false)
  assert.equal(shouldQuit({ freeMB: 4000, rssMB: 2000, working: 0 }), true)
  assert.equal(shouldQuit({ freeMB: 4000, rssMB: 300, working: 0 }), false)
})
