/**
 * insuranceFetch.test.js — the insurance certificate comes back from FetaP
 * (asked on 2026-11-19). The Issued Certificates list cannot be searched, so
 * the batches of the day her insurance was requested are opened first (the one
 * with as many certificates as hers first), and a day after the request the
 * fetch is queued by itself — once, never while she has her certificate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'

import { pickBatches, dayOf, insuranceHistory } from '../src/services/insuranceFetch.js'
import { queueInsuranceFetch } from '../src/services/autoScanner.js'
import { WORKFLOWS } from '../src/services/workflows.js'

const ROWS = [
  { index: 0, date: '2026-11-19', count: 4 },
  { index: 1, date: '2026-11-19', count: 1 },
  { index: 2, date: '2026-11-18', count: 1 },
  { index: 3, date: '2026-11-18', count: 2 },
  { index: 4, date: '2026-11-17', count: 16 },
  { index: 5, date: '2026-11-10', count: 1 },
]

test('the day of the request first, the batch of her size first, nothing far away', () => {
  const got = pickBatches(ROWS, '2026-11-18T09:30:00', 2)
  // 18th: the batch of 2 (hers), then the other; 19th: in list order; 17th (the day before) last; the 10th never.
  assert.deepEqual(got.map(b => b.index), [3, 2, 0, 1, 4])
  // Without a recorded request: the newest batches only.
  assert.equal(pickBatches(ROWS, null).length, 6)
  assert.equal(dayOf('2026-11-18T09:30:00'), '2026-11-18')
})

async function freshDb() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => {
    t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.integer('account_id'); t.string('status'); t.string('pause_reason')
    t.integer('current_step'); t.text('context'); t.text('log'); t.string('created_at'); t.string('updated_at')
  })
  await db.schema.createTable('insurance_accounts', t => { t.increments('id'); t.string('name'); t.string('username'); t.string('password'); t.integer('is_default') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id') })
  await db('insurance_accounts').insert({ name: 'Nuzla', username: 'u', password: 'p', is_default: 1 })
  return db
}

test('a day after her request the fetch is queued once; not with her certificate on file', async () => {
  const db = await freshDb()
  const now = Date.parse('2026-11-20T10:00:00Z')
  const at = (h) => new Date(now - h * 3600 * 1000).toISOString()
  // Profile 1: requested 30 h ago with two others on the certificate; profile 2: 5 h ago; profile 3: done and has it.
  const [lead] = await db('automation_queue').insert({ profile_id: 1, workflow_id: 'insurance_certificate', status: 'done', created_at: at(30), updated_at: at(29) })
  await db('automation_queue').insert([
    { profile_id: 4, workflow_id: 'insurance_certificate', status: 'paused', pause_reason: `with-run-${lead}`, created_at: at(30), updated_at: at(30) },
    { profile_id: 5, workflow_id: 'insurance_certificate', status: 'paused', pause_reason: `with-run-${lead}`, created_at: at(30), updated_at: at(30) },
    { profile_id: 2, workflow_id: 'insurance_certificate', status: 'done', created_at: at(5), updated_at: at(5) },
    { profile_id: 3, workflow_id: 'insurance_certificate', status: 'done', created_at: at(40), updated_at: at(40) },
  ])
  const [f] = await db('profile_fields').insert({ profile_id: 3, name: 'Insurance' })
  await db('files').insert({ profile_field_id: f })

  assert.equal(await queueInsuranceFetch(db, now), 3) // 1, 4 and 5 — not 2 (too early) nor 3 (has it)
  const queued = await db('automation_queue').where('workflow_id', 'insurance_fetch').pluck('profile_id')
  assert.deepEqual(queued.sort(), [1, 4, 5])
  assert.equal(await queueInsuranceFetch(db, now), 0) // already queued

  const h = await insuranceHistory(db, 4)
  assert.equal(h.count, 1)
  assert.equal(h.size, 3) // three on that certificate
  await db.destroy()
})

test('the robot is listed, so its button shows on the profile', () => {
  assert.equal(WORKFLOWS.insurance_fetch?.id, 'insurance_fetch')
  assert.match(WORKFLOWS.insurance_fetch.target, /certificate\/approved/)
})
