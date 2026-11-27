/**
 * pcReport.test.js — every PC's own problems to the tower (the owner, 2026-11-27), with a
 * mock tower: log errors grouped with counts, failed runs and slow steps, the PC's health,
 * nothing personal in any line, waits while a run works, off with ADAL_PC_REPORTS=0.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-report-'))
process.env.ADAL_REPORT_DATA = tmp
process.env.ADAL_NO_NET_PROBE = '1'
const R = await import('../src/services/pcReport.js')
const ME = '11111111-2222-3333-4444-555555555555'

const dbs = []
test.after(async () => { for (const d of dbs) await d.destroy() })
async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  dbs.push(db)
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db.schema.createTable('employees', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('run_history', t => { t.increments('id'); t.string('workflow'); t.string('workflow_id'); t.string('site'); t.string('outcome'); t.text('reason'); t.text('step'); t.string('started_at'); t.integer('duration_s') })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('workflow_id'); t.text('log'); t.string('updated_at') })
  await db('profiles').insert([{ full_name: 'Amina Bekele Tesfaye' }, { full_name: 'Hirut Alemu' }])
  await db('employees').insert({ name: 'Selam Girma' })
  return db
}
function mockTower() {
  const rows = new Map(), calls = []
  const cloud = async (method, p, body) => {
    calls.push({ method, p })
    if (method === 'POST' && p.startsWith('/rest/v1/keep_meta')) { for (const r of body) { assert.equal(r.agency_id, ME); rows.set(r.key, r.data) } return null }
    throw new Error(`the report asked something else: ${method} ${p}`)
  }
  return { link: { cloud, me: ME }, rows, calls }
}
const noFocus = { held: () => false }

test('a line keeps nothing personal', () => {
  const names = new Set(['amina', 'bekele', 'hirut'])
  const l = R.clean('Musaned failed for Amina Bekele passport EP1234567 phone +251 911 234 567 password=abc123 code ABCD-1234 at 2026-11-27 አሚና email a.b@x.com', names)
  for (const bad of ['Amina', 'Bekele', 'EP1234567', '911', 'abc123', 'ABCD-1234', 'አሚና', 'a.b@x.com']) assert.ok(!l.includes(bad), `${bad} in: ${l}`)
  assert.match(l, /Musaned failed for \[name\]/); assert.match(l, /2026-11-27/, 'a date stays')
})

test('the report: errors grouped with counts, failed runs, slow steps, the PC; nothing personal; to the mock tower', async () => {
  R._reset()
  const db = await makeDb()
  const now = new Date()
  const iso = (ms) => new Date(now.getTime() - ms).toISOString()
  fs.writeFileSync(path.join(tmp, 'server.log'), [
    `${iso(9000)} [worker] Musaned failed for Amina Bekele (passport EP1234567): timeout 30000ms`,
    `${iso(8000)} [worker] Musaned failed for Hirut Alemu (passport EP7654321): timeout 31000ms`,
    `${iso(7000)} [sync] all good, 0 errors`,
    `${iso(6000)} Error: ENOENT: no such file 'C:\\\\x\\\\a.png'`,
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(tmp, 'robots.log'), 'UnhandledPromiseRejection: page crashed (tab 3)\nnormal line\n')
  await db('run_history').insert([
    { workflow: 'Musaned contract', site: 'Musaned', outcome: 'failed', reason: 'Amina Bekele: no passport scan', step: 'Upload for Hirut Alemu', started_at: iso(60_000), duration_s: 80 },
    { workflow: 'LMIS', site: 'LMIS', outcome: 'done', step: 'x', started_at: iso(50_000) },
  ])
  await db('automation_queue').insert({ workflow_id: 'musaned_contract', updated_at: iso(1000), log: JSON.stringify([
    { ts: iso(100_000), msg: 'Open Musaned' }, { ts: iso(90_000), msg: 'Search Amina Bekele' }, { ts: iso(30_000), msg: 'Save' }, { ts: iso(29_000), msg: 'done' }]) })
  const t = mockTower()
  const r = await R.reportOnce(db, { version: () => ({ sha: 'abc1234' }), link: t.link, focus: noFocus })
  assert.equal(r.sent, true)
  const d = t.rows.get('/_tower/report')
  assert.ok(d, 'the row "/_tower/report" was written'); assert.equal(t.calls.length, 1)
  assert.equal(d.version, 'abc1234')
  assert.ok(d.sys.ram_free_mb > 0 && d.sys.cores > 0 && 'cpu_busy' in d.sys && 'disk_free_mb' in d.sys)
  const timeout = d.errors.find(e => /Musaned failed/.test(e.line))
  assert.equal(timeout.today, 2, 'two girls, one group, counted twice')
  assert.ok(d.errors.some(e => e.source === 'robots' && /page crashed/.test(e.line)))
  assert.ok(!d.errors.some(e => /0 errors/.test(e.line)), '"0 errors" is no problem')
  assert.equal(d.runs_failed.length, 1); assert.match(d.runs_failed[0].step, /Upload for \[name\]/)
  assert.equal(d.slow_steps[0].max_s, 60); assert.match(d.slow_steps[0].step, /Search \[name\]/)
  const all = JSON.stringify(d)
  for (const bad of ['Amina', 'Bekele', 'Hirut', 'Alemu', 'EP1234567', 'EP7654321', 'Selam']) assert.ok(!all.includes(bad), `${bad} sent`)
  assert.ok(all.length < 20_000, `small: ${all.length}`)
  // Next round: only what was added is read; the counts go on.
  fs.appendFileSync(path.join(tmp, 'server.log'), `${iso(10)} [worker] Musaned failed for Hirut Alemu (passport EP1111111): timeout 29000ms\n`)
  const d2 = (await R.reportOnce(db, { version: () => null, link: t.link, focus: noFocus })).data
  assert.equal(d2.errors.find(e => /Musaned failed/.test(e.line)).today, 3)
  assert.equal(d2.errors.find(e => /page crashed/.test(e.line)).today, 1, 'an old line is not counted again')
})

test('yesterday\'s counts after midnight', async () => {
  R._reset()
  fs.writeFileSync(path.join(tmp, 'server.log'), 'Error: boom\n'); fs.writeFileSync(path.join(tmp, 'robots.log'), ''); fs.writeFileSync(path.join(tmp, 'launcher.log'), '')
  const day1 = new Date('2026-11-26T15:00:00'), day2 = new Date('2026-11-27T09:00:00')
  R.readLogs(new Set(), { now: day1 })
  fs.appendFileSync(path.join(tmp, 'server.log'), 'Error: boom\n')
  R.readLogs(new Set(), { now: day2 })
  const db = await makeDb()
  const d = await R.buildReport(db, { cpuMs: 10, now: day2 })
  const g = d.errors.find(e => /boom/.test(e.line))
  assert.equal(g.today, 1); assert.equal(g.yesterday, 1); assert.equal(g.first, day1.toISOString())
})

test('a run working: the report waits; ADAL_PC_REPORTS=0: nothing at all', async () => {
  const db = await makeDb(), t = mockTower()
  assert.deepEqual(await R.reportOnce(db, { link: t.link, focus: { held: () => true } }), { waited: true })
  process.env.ADAL_PC_REPORTS = '0'
  try { assert.deepEqual(await R.reportOnce(db, { link: t.link, focus: noFocus }), { off: true }) } finally { delete process.env.ADAL_PC_REPORTS }
  assert.equal(t.calls.length, 0, 'the tower was never called')
})
