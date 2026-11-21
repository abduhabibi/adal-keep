/**
 * markDone.test.js — "mark as done" moves her to the next stage (asked on
 * 2026-11-21): one function for the pop-ups' "✔️ … saved", a step's tick and
 * a journey step; her stage (journeyOf → phaseOf) moves at once; Undo puts
 * everything back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'

// A throwaway vault key in a temp folder (never the PC's own).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markdone-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'k')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'outside')

const { markStepDone, undoMarkDone } = await import('../src/services/markDone.js')
const { journeyOf } = await import('../src/routes/automations.js')
const { phaseOf, AFTER } = await import('../../adal-keep-frontend/src/lib/phase.js')

async function setup() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => {
    t.increments('id'); t.string('full_name'); t.string('status'); t.string('visa_stage'); t.string('visa_applied_at')
    t.string('musaned_stage'); t.string('chosen_at'); t.text('notes'); t.string('updated_at'); t.string('tasheer_ref'); t.string('tasheer_date')
  })
  await db.schema.createTable('automation_queue', t => {
    t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason')
    t.integer('current_step'); t.text('context'); t.text('log'); t.string('created_at'); t.string('updated_at'); t.string('finished_at')
  })
  return db
}
const phase = async (db, id) => {
  const p = await db('profiles').where('id', id).first()
  const runs = {}
  for (const r of await db('automation_queue').where('profile_id', id).orderBy('id')) runs[r.workflow_id] = r
  const j = journeyOf(p, runs, true)
  const steps = Object.fromEntries([...j.embassy, ...j.extra].map(s => [s.key, s.state]))
  return phaseOf(steps, p, AFTER)
}

test('mark as done moves her on, and Undo puts her back', async () => {
  const db = await setup()
  const [id] = await db('profiles').insert({ full_name: 'Almaz', musaned_stage: 'EPRO APPROVAL', chosen_at: '2026-11-01', status: 'medical_applied' })
  await db('automation_queue').insert({ profile_id: id, workflow_id: 'musaned_add_candidate', status: 'done' })
  assert.equal(await phase(db, id), 'wafid')

  // "Medical done" (a waiting result check): FIT → LMIS.
  const [w] = await db('automation_queue').insert({ profile_id: id, workflow_id: 'wafid_check', status: 'paused', pause_reason: 'awaiting-human-save' })
  const r1 = await markStepDone(db, { runId: w })
  assert.equal((await db('profiles').where('id', id).first()).status, 'medical_fit')
  assert.equal((await db('automation_queue').where('id', w).first()).status, 'done')
  assert.equal(await phase(db, id), 'lmis')

  // The LMIS contract ticked → EPRO; EPRO approved → the first step after it (Tasheer).
  await markStepDone(db, { profileId: id, workflowId: 'lmis_contract' })
  assert.equal(await phase(db, id), 'epro')
  const r3 = await markStepDone(db, { profileId: id, step: 'epro' })
  assert.match((await db('profiles').where('id', id).first()).musaned_stage, /EPRO APPROVED/)
  assert.equal(await phase(db, id), 'tasheer')

  // "✔️ Tasheer saved" on a paused group run: she and the others on it are done.
  const [id2] = await db('profiles').insert({ full_name: 'Hiwot', musaned_stage: 'EPRO APPROVED' })
  const [t] = await db('automation_queue').insert({ profile_id: id, workflow_id: 'tasheer_schedule', status: 'paused', pause_reason: 'awaiting-tasheer-save' })
  const [m] = await db('automation_queue').insert({ profile_id: id2, workflow_id: 'tasheer_schedule', status: 'paused', pause_reason: `with-run-${t}` })
  const r4 = await markStepDone(db, { runId: t })
  assert.equal(await phase(db, id), 'insurance')
  assert.equal((await db('automation_queue').where('id', m).first()).status, 'done')

  // Undo: the group run and its member wait again; she is back on Tasheer.
  await undoMarkDone(db, r4.undo)
  assert.equal((await db('automation_queue').where('id', t).first()).pause_reason, 'awaiting-tasheer-save')
  assert.equal((await db('automation_queue').where('id', m).first()).status, 'paused')
  assert.equal(await phase(db, id), 'tasheer')
  await undoMarkDone(db, r3.undo)
  assert.equal((await db('profiles').where('id', id).first()).musaned_stage, 'EPRO APPROVAL')
  await undoMarkDone(db, r1.undo)
  assert.equal((await db('profiles').where('id', id).first()).status, 'medical_applied')
  await assert.rejects(undoMarkDone(db, r1.undo), /Too late/)

  // Undo put the result check back to waiting.
  assert.equal((await db('automation_queue').where('id', w).first()).status, 'paused')
  // A run that is not waiting cannot be marked; a running one is refused.
  await db('automation_queue').where('id', w).update({ status: 'failed' })
  await assert.rejects(markStepDone(db, { runId: w }), /only a run waiting/)
  await db('automation_queue').insert({ profile_id: id, workflow_id: 'insurance_certificate', status: 'running' })
  await assert.rejects(markStepDone(db, { profileId: id, step: 'insurance' }), /working in its tab/)
  await db.destroy()
})
