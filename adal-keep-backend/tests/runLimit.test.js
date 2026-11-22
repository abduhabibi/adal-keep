// No robot run lasts more than 10 minutes, and the update never waits longer than that for runs
// (owner, 2026-11-22). The clock counts only the robot's own work: waiting for a person stands still.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-limit-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'keys')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'

const R = await import('../src/services/runLimit.js')
const W = await import('../src/services/worker.js')
const S = await import('../src/routes/systemUpdate.js')
const C = await import('../src/services/cancellation.js')

test('the limit is 10 minutes', () => { assert.equal(R.RUN_LIMIT_MS, 600000); assert.equal(R.LIMIT_NOTE, 'stopped after 10 minutes') })

test('the clock fires at the limit and not before', async () => {
  let t = 0
  const c = R.startRunClock({ limitMs: 600, tickMs: 10, now: () => t })
  let fired = false
  c.hit.then(() => { fired = true })
  for (t = 100; t < 600; t += 100) await new Promise(r => setTimeout(r, 15))
  assert.equal(fired, false)
  t = 700; await new Promise(r => setTimeout(r, 30))
  assert.equal(fired, true)
  c.stop()
})

test('waiting for a person stops the clock', async () => {
  let t = 0, waiting = false
  const c = R.startRunClock({ limitMs: 700, tickMs: 10, now: () => t, waiting: () => waiting })
  let fired = false
  c.hit.then(() => { fired = true })
  t = 300; await new Promise(r => setTimeout(r, 25))
  waiting = true
  t = 5000; await new Promise(r => setTimeout(r, 25))   // a long wait for a code: not counted
  assert.equal(fired, false); assert.ok(c.activeMs() < 700)
  waiting = false
  t = 5300; await new Promise(r => setTimeout(r, 25))
  assert.equal(fired, false)
  t = 5600; await new Promise(r => setTimeout(r, 25))
  assert.equal(fired, true)
  c.stop()
})

test('withTimeout gives the fallback when the database does not answer', async () => {
  const t0 = Date.now()
  assert.equal(await R.withTimeout(new Promise(() => {}), 50, 'late'), 'late')
  assert.equal(await R.withTimeout(Promise.reject(new Error('x')), 50, 'bad'), 'bad')
  assert.equal(await R.withTimeout(Promise.resolve(7), 50, 'late'), 7)
  assert.ok(Date.now() - t0 < 1000)
})

test('a run past the limit is cancelled with the note, its tab closed, whatever the workflow does', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason'); t.text('log'); t.string('finished_at'); t.string('updated_at') })
  await db('automation_queue').insert({ id: 15, workflow_id: 'musaned_add_candidate', status: 'running', log: '[]' })
  let closed = false
  await W.stopAtLimit(db, { id: 15, workflow_id: 'musaned_add_candidate' }, { close: async () => { closed = true } })
  const row = await db('automation_queue').where('id', 15).first()
  assert.equal(row.status, 'cancelled'); assert.equal(row.pause_reason, 'stopped after 10 minutes'); assert.ok(row.finished_at)
  assert.match(row.log, /Stopped after 10 minutes/)
  assert.equal(closed, true); assert.equal(C.isCancelled(15), true); assert.equal(W._limited.has(15), true)
  // a run that already finished is not touched
  await db('automation_queue').insert({ id: 16, workflow_id: 'lmis', status: 'done', log: '[]' })
  await W.stopAtLimit(db, { id: 16, workflow_id: 'lmis' }, null)
  assert.equal((await db('automation_queue').where('id', 16).first()).status, 'done')
  await db.destroy()
})

test('the update waits for runs at most 10 minutes, then goes on', () => {
  const T0 = 1_000_000
  assert.deepEqual(S.holdForRuns(false, 0, T0), { wait: false, since: 0, waited: 0 })
  const first = S.holdForRuns(true, 0, T0)
  assert.equal(first.wait, true); assert.equal(first.since, T0)
  assert.equal(S.holdForRuns(true, first.since, T0 + 9 * 60000).wait, true)
  const late = S.holdForRuns(true, first.since, T0 + 10 * 60000)
  assert.equal(late.wait, false); assert.equal(late.waited, 600000)
  // idle in between resets the wait
  assert.equal(S.holdForRuns(false, first.since, T0 + 11 * 60000).since, 0)
})
