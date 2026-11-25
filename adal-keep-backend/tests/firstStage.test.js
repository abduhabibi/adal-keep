/**
 * firstStage.test.js — the first stage moves by itself (asked on 2026-11-19):
 * her CV is made once all it needs is there, then Musaned: Add candidate is
 * queued once — never again while a run is in line, done or just failed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'

import { cvBlockers, wantsMusaned, pushFirstStage } from '../src/services/firstStage.js'

test('her CV is made only with everything it needs', () => {
  const p = { broker_id: 1, religion: 'Muslim', marital_status: 'Single' }
  assert.deepEqual(cvBlockers(p, { hasPhoto: true, hasFullBody: true }), [])
  assert.deepEqual(cvBlockers({ ...p, religion: '' }, { hasPhoto: true, hasFullBody: true }), ['Religion missing'])
  assert.deepEqual(cvBlockers(p, { hasPhoto: true, hasFullBody: false }), ['Full body photo missing'])
  assert.ok(cvBlockers({}, { hasPhoto: false, hasFullBody: false }).length === 5)
})

test('Musaned once, after her CV', () => {
  const p = {}
  assert.equal(wantsMusaned(p, {}, false), false)                 // no CV yet
  assert.equal(wantsMusaned(p, {}, true), true)
  assert.equal(wantsMusaned({ musaned_stage: 'On Musaned' }, {}, true), false)
  for (const status of ['pending', 'running', 'paused', 'done']) {
    assert.equal(wantsMusaned(p, { musaned_add_candidate: { id: 1, status } }, true), false, status)
  }
  const now = new Date().toISOString(), old = new Date(Date.now() - 3 * 3600e3).toISOString()
  assert.equal(wantsMusaned(p, { musaned_add_candidate: { id: 1, status: 'failed', updated_at: now } }, true), false)
  // One agent, one try: hours later too, and a cancelled one (tests/oneTry.test.js).
  assert.equal(wantsMusaned(p, { musaned_add_candidate: { id: 1, status: 'failed', updated_at: old } }, true), false)
  assert.equal(wantsMusaned(p, { musaned_add_candidate: { id: 1, status: 'cancelled', updated_at: old } }, true), false)
  // Deleted from Musaned on purpose: not put back by itself.
  assert.equal(wantsMusaned(p, { musaned_add_candidate: { id: 1, status: 'done' }, musaned_delete: { id: 2, status: 'done' } }, true), false)
})

test('off in Settings: nothing happens', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('settings', t => { t.string('key'); t.string('value') })
  await db('settings').insert({ key: 'first_stage_auto', value: '0' })
  assert.deepEqual(await pushFirstStage(db, { log: () => {} }), { cvs: 0, musaned: 0 })
  await db.destroy()
})
