import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import knex from 'knex'

const { musanedState, askState, claim, claimHere, _resetAsk } = await import('../src/services/musanedAsk.js')
const router = (await import('../src/routes/musanedAsk.js')).default

async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('status'); t.string('musaned_stage'); t.string('chosen_at'); t.string('contract_number') })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason') })
  await db('profiles').insert({ id: 1, full_name: 'HANNA' })
  return db
}
const run = (db, status, workflow_id = 'musaned_add_candidate', pause_reason = null) => db('automation_queue').insert({ profile_id: 1, workflow_id, status, pause_reason })

test('asked only when nothing is in line, working, waiting or done', async () => {
  const db = await makeDb(); _resetAsk()
  const at = async () => { const s = await musanedState(db, 1); return [s.ask, s.state] }
  assert.deepEqual(await at(), [true, 'none'])
  for (const [status, want] of [['pending', 'queued'], ['running', 'working'], ['paused', 'waiting'], ['done', 'on']]) {
    await db('automation_queue').del(); await run(db, status)
    assert.deepEqual(await at(), [false, want], status)
  }
  for (const status of ['failed', 'cancelled']) { await db('automation_queue').del(); await run(db, status); assert.equal((await at())[0], true, status) }
  await run(db, 'done', 'musaned_delete')
  assert.equal((await at())[0], true, 'deleted from Musaned: may be asked')
  await run(db, 'done')
  assert.deepEqual(await at(), [false, 'on'], 'added again after the delete')
  await db('automation_queue').del()
  await db('profiles').update({ musaned_stage: 'IN OUR LIST' }); assert.deepEqual(await at(), [false, 'on'])
  await db('profiles').update({ musaned_stage: 'Registered by another agency' }); assert.deepEqual(await at(), [false, 'elsewhere'])
  assert.equal(await musanedState(db, 99), null)
  await db.destroy()
})

test('two PCs at once: the main PC gives it to the first only; a refused start gives it back', async () => {
  const db = await makeDb(); _resetAsk()
  const both = await Promise.all([claimHere(db, 1), claimHere(db, 1)])
  assert.deepEqual(both.map(x => x.ask).sort(), [false, true])
  assert.equal((await askState(db, 1, { companion: false })).state, 'queued')
  await claimHere(db, 1, { release: true })
  assert.equal((await askState(db, 1, { companion: false })).ask, true)
  // Its run has come: what it says counts, not the memory; cancelled at once, it may be asked again.
  await claimHere(db, 1); await run(db, 'pending')
  assert.equal((await askState(db, 1, { companion: false })).state, 'queued')
  await db('automation_queue').update({ status: 'cancelled' })
  assert.equal((await askState(db, 1, { companion: false })).ask, true)
  await db.destroy()
})

test('a Companion: the main PC answers; none or an older one: its own copy does', async () => {
  const db = await makeDb(); _resetAsk()
  const say = (body, ok = true) => async () => ({ ok, json: async () => body })
  assert.equal((await askState(db, 1, { companion: true, fetchIt: say({ ask: false, state: 'working', text: 'working now' }) })).state, 'working')
  assert.equal((await askState(db, 1, { companion: true, fetchIt: say({}, false) })).ask, true)
  assert.equal(await claim(db, 1, { companion: true, fetchIt: async () => { throw new Error('off') } }), null)
  let asked = 0
  assert.equal((await askState(db, 1, { companion: true, fetchIt: async () => { asked++; throw new Error('off') } })).ask, true)
  assert.equal(asked, 0, 'off just now: not waited for again')
  await db.destroy(); _resetAsk()
})

test('the start, over HTTP: once only, the person resuming a paused run still may, an error never stops it', async () => {
  const db = await makeDb(); _resetAsk()
  const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api', router)
  let started = 0, code = 200
  app.post('/api/profiles/:id/automations/:wf/start', async (req, res) => { started++; res.status(code).json({ ok: code < 400 }) })
  const server = http.createServer(app).listen(0); const base = `http://127.0.0.1:${server.address().port}/api/profiles/1`
  const go = async (body = { popup: true }) => (await fetch(`${base}/automations/musaned_add_candidate/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  try {
    code = 400; await go(); await new Promise(r => setTimeout(r, 30)); code = 200
    started = 0
    const two = await Promise.all([go(), go()])
    assert.equal(started, 1); assert.equal(two.filter(x => x.already).length, 1)
    await run(db, 'paused'); started = 0
    assert.equal((await go()).state, 'waiting'); assert.equal(started, 0, 'the pop-up never wakes a waiting run')
    await go({}); assert.equal(started, 1, 'AI Actions: Continue')
    await go({ check: true }); await go({ anyStep: true }); assert.equal(started, 3)
    assert.equal((await (await fetch(`${base}/musaned-state`)).json()).state, 'waiting')
    process.env.ADAL_MUSANED_ASK = '0'
    await go(); assert.equal(started, 4); assert.equal((await fetch(`${base}/musaned-state`)).status, 404)
    delete process.env.ADAL_MUSANED_ASK
    app.locals.db = () => { throw new Error('broken') }
    await go(); assert.equal(started, 5)
  } finally { delete process.env.ADAL_MUSANED_ASK; server.close(); await db.destroy(); _resetAsk() }
})
