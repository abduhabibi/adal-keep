/** profileRuns.test.js — her robots' newest runs (GET /profiles/:id/automations, asked every few seconds): without their logs, the rest as before. */
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import knex from 'knex'

test('the newest run of each robot, without its log and passwords; another girl\'s are not hers', async () => {
  const { default: router } = await import('../src/routes/automations.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); for (const c of ['workflow_id', 'status', 'pause_reason', 'finished_at', 'updated_at', 'created_at', 'context', 'log']) t.text(c); t.integer('profile_id'); t.integer('account_id') })
  await db.schema.createTable('profiles', t => { t.increments('id'); for (const c of ['full_name', 'chosen_at', 'contract_number', 'musaned_stage', 'status', 'visa_application_number', 'visa_stage']) t.string(c) })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id') })
  await db('profiles').insert([{ id: 7, full_name: 'A' }, { id: 8, full_name: 'B' }])
  const run = (profile_id, workflow_id, status, extra = {}) => ({ profile_id, workflow_id, status, context: JSON.stringify({ password: 'x', site: 'm' }), log: 'L'.repeat(50000), ...extra })
  await db('automation_queue').insert([run(7, 'wafid_book', 'failed'), run(7, 'wafid_book', 'paused', { pause_reason: 'awaiting-human-save' }), run(7, 'lmis_contract', 'done'), run(8, 'wafid_book', 'running')])
  const app = express(); app.locals.db = db; app.use(router)
  const server = app.listen(0)
  try {
    const text = await (await fetch(`http://127.0.0.1:${server.address().port}/profiles/7/automations`)).text()
    const by = Object.fromEntries(JSON.parse(text).workflows.map(w => [w.id, w.latest]))
    assert.equal(by.wafid_book.id, 2); assert.equal(by.wafid_book.status, 'paused'); assert.equal(by.wafid_book.pause_reason, 'awaiting-human-save')
    assert.equal(by.lmis_contract.id, 3)
    assert.equal('log' in by.wafid_book, false)
    assert.deepEqual(JSON.parse(by.wafid_book.context), { site: 'm' })
    assert.ok(text.length < 40000, `${text.length}`)
  } finally { server.close(); await db.destroy() }
})
