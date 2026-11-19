import test from 'node:test'
import assert from 'node:assert/strict'
import { itemsFor, currentStep, tellToday } from '../src/services/needsAction.js'

const NOW = new Date(2026, 10, 19, 10, 0)   // 2026-11-19
const kinds = (items) => items.map(i => i.kind).sort()

test('her current step: the first one not reached', () => {
  assert.equal(currentStep({}), 'cv')
  assert.equal(currentStep({ cv: 'done', musaned: 'waiting' }), 'selected')
  assert.equal(currentStep({ cv: 'done', musaned: 'done', selected: 'done', wafid: 'active' }), 'wafid')
})

test('what is due today, from her steps, status, dates and documents', () => {
  const p = { id: 1, full_name: 'A', status: 'medical_applied', chosen_at: '2026-11-01', medical_valid_until: '2026-11-23', wafid_appt_date: '2026-11-10', tasheer_date: '2026-11-19', tasheer_time: '09:30' }
  const st = { steps: { cv: 'done', musaned: 'done', selected: 'done', wafid: 'active', epro: 'active', wakala: 'failed' }, missing: { wafid: ['Appointment Slip'] }, problem: 'Wafid slip: the site did not answer' }
  const items = itemsFor(p, st, { wafid_slip: { workflow_id: 'wafid_slip', status: 'paused' } }, NOW)
  assert.deepEqual(kinds(items), ['appt', 'docs', 'medical', 'musaned', 'musaned', 'result', 'stuck', 'stuck'])
  assert.ok(items.find(i => i.kind === 'medical').text.includes('in 4 days'))
  assert.ok(items.find(i => i.kind === 'appt').text.includes('Tasheer today at 09:30'))
  assert.ok(items.find(i => i.kind === 'result').overdue)
})

test('chosen 3+ days ago and Wafid not booked: overdue; a ran-out medical too', () => {
  const p = { id: 2, status: '', chosen_at: '2026-11-15', medical_valid_until: '2026-11-18' }
  const items = itemsFor(p, { steps: { cv: 'done', musaned: 'done', selected: 'done', wafid: 'todo' } }, {}, NOW)
  assert.deepEqual(kinds(items), ['chosen', 'medical'])
  assert.ok(items.every(i => i.overdue))
  // Chosen yesterday: not yet.
  assert.deepEqual(itemsFor({ ...p, chosen_at: '2026-11-18', medical_valid_until: null }, { steps: { selected: 'done', wafid: 'todo' } }, {}, NOW), [])
})

test('arrived or UNFIT: nothing due; nothing known: nothing listed', () => {
  assert.deepEqual(itemsFor({ medical_valid_until: '2026-11-01' }, { steps: { arrived: 'done' } }, {}, NOW), [])
  assert.deepEqual(itemsFor({ status: 'medical_rejected', medical_valid_until: '2026-11-01' }, {}, {}, NOW), [])
  assert.deepEqual(itemsFor({}, { steps: { cv: 'done' } }, {}, NOW), [])
})

test('one notification a day, opening the dashboard', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('status'); t.string('chosen_at'); t.string('medical_valid_until'); t.string('musaned_stage')
    for (const c of ['visa_stage', 'visa_application_number', 'musaned_pro', 'employer_name', 'work_city', 'contract_number', 'labor_id', 'visa_number', 'musaned_payment', 'tasheer_ref', 'tasheer_date']) t.string(c)
  })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.string('pause_reason'); t.string('finished_at') })
  await db.schema.createTable('settings', t => { t.string('key'); t.text('value'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('notifications', t => { t.increments('id'); t.string('type'); t.string('title'); t.text('body'); t.string('created_day') })
  await db('profiles').insert({ full_name: 'Abeba', status: 'medical_fit', medical_valid_until: '2026-11-17' })
  assert.equal((await tellToday(db, NOW)).told, true)
  assert.equal((await tellToday(db, NOW)).told, false)
  const n = await db('notifications').first()
  assert.equal(n.type, 'needs_action')
  assert.match(n.title, /Needs action today: 1 girl \(1 overdue\)/)
  assert.match(n.body, /Abeba: /)
  await db.destroy()
})
