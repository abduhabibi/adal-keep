import test from 'node:test'
import assert from 'node:assert/strict'
import { inWafidPhase } from '../src/routes/automations.js'
import { inWorkingHours, wafidDaily, hello, lease, nextStep, answerStep, _wafidTickForTest } from '../src/services/selectionCheck.js'
import { saveResult } from '../src/services/wafidStatus.js'
import * as phase from '../../adal-keep-frontend/src/lib/phase.js'

test('the Wafid tab: backend and page agree', () => {
  const cases = [
    [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'active' }, { status: 'medical_applied' }],
    [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'active' }, {}],
    [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'failed' }, {}],
    [{ cv: 'done', musaned: 'done', selected: 'done' }, {}],                                     // Selected, not booked
    [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'done' }, { status: 'medical_fit' }], // FIT: moved on
    [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'failed' }, { status: 'medical_rejected' }], // Unfit tab
    [{ cv: 'done', musaned: 'waiting' }, { status: 'medical_applied' }],                         // not chosen
    [{ cv: 'done', musaned: 'done', selected: 'done', epro: 'done', wafid: 'active' }, {}],
  ]
  for (const [steps, p] of cases) {
    assert.equal(inWafidPhase(steps, p), phase.phaseOf(steps, p, []) === 'wafid', JSON.stringify([steps, p]))
  }
})

test('working hours: Monday to Saturday, 09:00 to 17:00', () => {
  assert.equal(inWorkingHours(new Date(2026, 10, 16, 10, 0)), true)    // Monday 10:00
  assert.equal(inWorkingHours(new Date(2026, 10, 16, 8, 59)), false)
  assert.equal(inWorkingHours(new Date(2026, 10, 16, 17, 0)), false)
  assert.equal(inWorkingHours(new Date(2026, 10, 21, 12, 0)), true)    // Saturday
  assert.equal(inWorkingHours(new Date(2026, 10, 22, 12, 0)), false)   // Sunday
})

async function memDb() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => {
    t.increments('id'); t.string('full_name'); t.string('passport_number'); t.string('nationality'); t.string('status')
    t.string('chosen_at'); t.string('musaned_stage'); t.string('updated_at')
  })
  await db.schema.createTable('automation_queue', t => {
    t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason')
    t.integer('current_step'); t.text('context'); t.text('log'); t.string('created_at'); t.string('updated_at'); t.string('started_at'); t.string('finished_at')
  })
  await db.schema.createTable('settings', t => { t.string('key'); t.text('value'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('tasks', t => {
    t.increments('id'); t.string('type'); t.string('title'); t.text('description'); t.string('status'); t.integer('profile_id')
    t.integer('assigned_to'); t.boolean('is_ai_created'); t.string('created_at')
  })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id') })
  return db
}

test('once a day, on the Companion with Adal Browser open: FIT moves her on, the day is noted', async () => {
  const db = await memDb()
  const [girl] = await db('profiles').insert({ full_name: 'Abeba', passport_number: 'ep1234567', status: 'medical_applied', chosen_at: '2026-11-01' })
  await db('profiles').insert({ full_name: 'Not chosen', passport_number: 'EP7654321', status: 'medical_applied' })
  // Her slip is in her profile already: nothing else is queued.
  const [f] = await db('profile_fields').insert({ profile_id: girl, name: 'Appointment Slip' })
  await db('files').insert({ profile_field_id: f })

  hello({ instance: 'pc-weak', name: 'Weak', cores: 2, free_mb: 1000, browser: true })
  hello({ instance: 'pc-b', name: 'PC B', cores: 16, free_mb: 8000, browser: true })
  hello({ instance: 'pc-c', name: 'PC C', cores: 32, free_mb: 8000, browser: false })   // Adal Browser closed: never
  const monday = new Date(2026, 10, 16, 10, 0)
  await _wafidTickForTest(db, monday)
  assert.equal(lease.kind, 'wafid')
  assert.equal(lease.holder, 'pc-b')
  const turn = hello({ instance: 'pc-b', name: 'PC B', cores: 16, free_mb: 8000, browser: true })
  assert.equal(turn.kind, 'wafid')
  // Only one girl is in the Wafid tab: one look-up.
  const job = await nextStep(turn.run)
  assert.equal(job.kind, 'wafid')
  assert.equal(job.args.passport, 'EP1234567')
  answerStep(turn.run, { id: job.id, ok: true, result: { state: 'fit', text: 'FIT' } })
  for (let i = 0; i < 100 && (wafidDaily.running || lease.token); i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(lease.token, '')
  assert.equal((await db('profiles').where('id', girl).first()).status, 'medical_fit')
  assert.equal((await db('profiles').where('full_name', 'Not chosen').first()).status, 'medical_applied')
  assert.equal((await db('automation_queue').where({ profile_id: girl, workflow_id: 'wafid_book' }).first()).status, 'done')
  assert.equal((await db('settings').where('key', 'wafid_daily_done').first()).value, '2026-11-16')
  // The same day: not again.
  await _wafidTickForTest(db, new Date(2026, 10, 16, 15, 0))
  assert.equal(lease.token, '')
  await db.destroy()
})

test('UNFIT goes to the Unfit tab; an unclear answer changes nothing', async () => {
  const db = await memDb()
  const [id] = await db('profiles').insert({ full_name: 'Hana', passport_number: 'EP1', status: 'medical_applied' })
  const p = await db('profiles').where('id', id).first()
  assert.equal(await saveResult(db, p, { state: 'pending', text: 'not final' }), false)
  assert.equal((await db('profiles').where('id', id).first()).status, 'medical_applied')
  assert.equal(await saveResult(db, p, { state: 'unfit', text: 'UNFIT' }), true)
  const after = await db('profiles').where('id', id).first()
  assert.equal(after.status, 'medical_rejected')
  assert.equal(phase.phaseOf({ cv: 'done', musaned: 'done', selected: 'done', wafid: 'failed' }, after, []), 'unfit')
  await db.destroy()
})
