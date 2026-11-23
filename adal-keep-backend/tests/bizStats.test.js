import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import * as S from '../src/services/bizStats.js'

const open = []
after(() => Promise.all(open.map(d => d.destroy())))
const NOW = Date.parse('2026-11-23T12:00:00Z')

async function db() {
  const d = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  open.push(d)
  await d.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('created_at') })
  await d.schema.createTable('generated_cvs', t => { t.increments('id'); t.string('created_at') })
  await d.schema.createTable('profile_days', t => { t.increments('id'); t.integer('profile_id'); t.string('day'); t.text('data') })
  await d.schema.createTable('run_history', t => { t.increments('id'); t.string('kind'); t.string('workflow_id'); t.string('started_at'); t.string('outcome'); t.integer('duration_s') })
  return d
}
const pd = (profile_id, day, stage) => ({ profile_id, day, data: JSON.stringify({ stage }) })

test('stage moves per day and the average days a stay lasted (only stays seen from start to end)', () => {
  const r = S.stageMoves([
    pd(1, '2026-11-01', 'cv'), pd(1, '2026-11-05', 'musaned'), pd(1, '2026-11-15', 'selected'),
    pd(2, '2026-11-02', 'cv'), pd(2, '2026-11-05', 'musaned'), pd(2, '2026-11-09', 'selected'),
    pd(3, '2026-11-03', 'cv'),
  ])
  assert.deepEqual(r.moves, { '2026-11-05': 2, '2026-11-15': 1, '2026-11-09': 1 })
  assert.deepEqual(r.stays, { musaned: { n: 2, avg_days: 7 } })   // 10 days and 4 days
})

test('the report is counts only: no names, ids or accounts', async () => {
  const d = await db()
  await d('profiles').insert([{ full_name: 'Secret Name', created_at: '2026-11-22T08:00:00Z' }, { full_name: 'Other', created_at: '2026-11-22T09:00:00Z' }, { full_name: 'Old', created_at: '2025-01-01T00:00:00Z' }])
  await d('generated_cvs').insert({ created_at: '2026-11-22T10:00:00Z' })
  await d('profile_days').insert([pd(7, '2026-11-20', 'cv'), pd(7, '2026-11-22', 'musaned')])
  await d('run_history').insert([
    { kind: 'run', workflow_id: 'wafid_book', started_at: '2026-11-22T10:00:00Z', outcome: 'done', duration_s: 120 },
    { kind: 'run', workflow_id: 'wafid_book', started_at: '2026-11-22T11:00:00Z', outcome: 'failed', duration_s: 30 },
    { kind: 'run', workflow_id: 'wafid_book', started_at: '2026-11-22T12:00:00Z', outcome: 'running', duration_s: 0 },
    { kind: 'move', workflow_id: 'pextran', started_at: '2026-11-22T12:00:00Z', outcome: 'done', duration_s: 5 },
  ])
  const rep = await S.statsReport(d, NOW)
  assert.equal(rep.profiles, 3)
  assert.equal(Object.values(rep.added).reduce((a, b) => a + b, 0), 2)
  assert.equal(Object.values(rep.cvs).reduce((a, b) => a + b, 0), 1)
  assert.equal(Object.values(rep.moves).reduce((a, b) => a + b, 0), 1)
  assert.deepEqual([rep.robots.wafid_book.done, rep.robots.wafid_book.failed, rep.robots.wafid_book.secs], [1, 1, 150])
  assert.equal(rep.robots.pextran, undefined)
  const text = JSON.stringify(rep)
  assert.ok(!/Secret|Other|Old/.test(text))
})

test('a missing table gives an empty part, not an error', async () => {
  const d = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true }); open.push(d)
  const rep = await S.statsReport(d, NOW)
  assert.deepEqual([rep.profiles, rep.added, rep.robots], [0, {}, {}])
})

test('merge adds agencies up; hours saved uses manual minutes of what finished', () => {
  const a = { profiles: 2, added: { '2026-11-22': 3 }, cvs: {}, moves: { '2026-11-22': 1 }, stages: { cv: { n: 2, avg_days: 2 } }, robots: { wafid_book: { done: 2, failed: 1, other: 0, secs: 60, d: { '2026-11-22': { done: 2, failed: 1 } } } } }
  const b = { profiles: 5, added: { '2026-11-22': 1 }, cvs: { '2026-11-22': 2 }, moves: {}, stages: { cv: { n: 2, avg_days: 4 } }, robots: { wafid_book: { done: 1, failed: 0, other: 1, secs: 20, d: { '2026-11-22': { done: 1, failed: 0 } } } } }
  const m = S.mergeReports([a, null, b])
  assert.equal(m.profiles, 7); assert.equal(m.added['2026-11-22'], 4); assert.deepEqual(m.stages.cv, { n: 4, avg_days: 3 })
  assert.equal(m.robots.wafid_book.done, 3)
  // 4 profiles × 8 + 2 CVs × 6 + 3 wafid_book × 12 = 32 + 12 + 36 = 80 min
  assert.equal(S.hoursSaved(m, 30, NOW), 1.3)
  assert.equal(S.hoursSaved(m, 1, NOW + 5 * 86400000), 0)
})
