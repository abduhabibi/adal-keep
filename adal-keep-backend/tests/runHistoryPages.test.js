// Robot history (owner, 2026-11-24): it must show at once (a light page at a time,
// pictures only when opened), every row can be deleted (the newest and a running
// one too, a running one only when the person said yes), and every PC of the
// agency shows the same list, with the PC that ran each run and the one that asked.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import express from 'express'
import { makePC, syncPair, scratch } from './helpers/syncPCs.js'

process.env.ADAL_SYNC_ID = path.join(scratch('rh-id'), 'sync-id.json')

const H = () => import('../src/services/runHistory.js')
const migration = () => import('../src/migrations/065_run_history.js')

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('pause_reason'); t.text('log') })
  await (await migration()).up(db)
  return db
}

test('the list: light columns only, a page at a time, the next page below the last row', async () => {
  const db = await setup()
  const h = await H()
  const ids = []
  for (let i = 0; i < 7; i++) ids.push(await h.begin(db, { run_id: i + 1, workflow_id: 'lmis', started_at: `2026-11-24T08:0${i}:00.000Z` }))
  // Two runs in the same second: both shown, once each.
  ids.push(await h.begin(db, { run_id: 8, workflow_id: 'lmis', started_at: '2026-11-24T08:06:00.000Z' }))
  await db('run_history_shots').insert({ history_id: ids[0], jpg: Buffer.alloc(50_000, 1), taken_at: 'x' })
  const first = await h.list(db, { limit: 3 })
  assert.equal(first.length, 3)
  for (const r of first) assert.deepEqual(Object.keys(r).sort(), [...h.LIST_COLS, 'asked_on'].sort(), 'no picture or other big column in the list')
  const seen = [...first]
  while (true) {
    const last = seen[seen.length - 1]
    const next = await h.list(db, { limit: 3, before: `${last.started_at}|${last.id}` })
    if (!next.length) break
    seen.push(...next)
  }
  assert.equal(seen.length, 8)
  assert.equal(new Set(seen.map(r => r.id)).size, 8)
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].started_at > seen[i].started_at || (seen[i - 1].started_at === seen[i].started_at && seen[i - 1].id > seen[i].id))
  assert.equal((await h.list(db)).length, 8, 'a page is 100 rows by default')
  await db.destroy()
})

test('500 rows of 30 days: the first page in well under 300 ms', async () => {
  const db = await setup()
  const h = await H()
  const rows = []
  for (let i = 0; i < 500; i++) rows.push({ run_id: i, workflow_id: 'musaned_add_candidate', workflow: 'Musaned', site: 'Musaned', outcome: i % 3 ? 'done' : 'failed', reason: 'x'.repeat(300), step: 'y'.repeat(240), started_at: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 3600_000).toISOString(), has_shot: i % 3 === 0 })
  for (let i = 0; i < rows.length; i += 100) await db('run_history').insert(rows.slice(i, i + 100))
  const shots = (await db('run_history').where('has_shot', true).select('id')).map(r => ({ history_id: r.id, jpg: Buffer.alloc(100 * 1024, 7), taken_at: 'x' }))
  for (const s of shots) await db('run_history_shots').insert(s)
  const t0 = performance.now()
  const page = await h.list(db)
  const took = performance.now() - t0
  assert.equal(page.length, 100)
  assert.ok(JSON.stringify(page).length < 100_000, 'the page is small')
  assert.ok(took < 300, `took ${took} ms`)
  await db.destroy()
})

test('delete: one row, several, the newest; a running one only after a yes', async () => {
  const db = await setup()
  const h = await H()
  const a = await h.begin(db, { run_id: 1, workflow_id: 'lmis', started_at: '2026-11-24T08:00:00.000Z' })
  const b = await h.begin(db, { run_id: 2, workflow_id: 'lmis', started_at: '2026-11-24T08:01:00.000Z' })
  const c = await h.begin(db, { run_id: 3, workflow_id: 'lmis', started_at: '2026-11-24T08:02:00.000Z' })
  const newest = await h.begin(db, { run_id: 4, workflow_id: 'lmis', started_at: '2026-11-24T08:03:00.000Z' })
  await h.finish(db, a, { outcome: 'failed', reason: 'x' })
  await h.finish(db, b, { outcome: 'done' })
  await h.finish(db, c, { outcome: 'paused', reason: 'waits' })
  await db('run_history_shots').insert({ history_id: a, jpg: Buffer.from([0xff, 0xd8]), taken_at: 'x' })
  // The newest is still running: refused without a yes, nothing goes.
  assert.deepEqual(await h.remove(db, [newest, b]), { deleted: 0, running: [newest] })
  assert.equal((await h.list(db)).length, 4)
  assert.deepEqual(await h.remove(db, [newest], { running_ok: true }), { deleted: 1, running: [] })
  assert.deepEqual(await h.remove(db, [a, b]), { deleted: 2, running: [] })
  assert.equal(await h.shotOf(db, a), null, 'its picture went with it')
  assert.deepEqual(await h.remove(db, String(c)), { deleted: 1, running: [] })
  assert.equal((await h.list(db)).length, 0)
  assert.deepEqual(await h.remove(db, []), { deleted: 0, running: [] })
  await db.destroy()
})

test('a running row deleted while it works: its end leaves no picture behind', async () => {
  const db = await setup()
  const h = await H()
  const id = await h.begin(db, { run_id: 5, workflow_id: 'lmis' })
  await h.remove(db, [id], { running_ok: true })
  await db('automation_queue').insert({ id: 5, status: 'failed', pause_reason: 'x', log: '[]' })
  await h.finish(db, id, { outcome: 'failed', page: { isClosed: () => false, screenshot: async () => { throw new Error('not needed') } } })
  await h.finishRun(db, 5, null)
  assert.equal((await db('run_history_shots').count('* as n'))[0].n, 0)
  assert.equal((await db('run_history').count('* as n'))[0].n, 0)
  await db.destroy()
})

test('the routes: list, delete one, delete several, 409 for a running one', async () => {
  const db = await setup()
  const h = await H()
  const done = await h.begin(db, { run_id: 1, workflow_id: 'lmis' })
  await h.finish(db, done, { outcome: 'done' })
  const run = await h.begin(db, { run_id: 2, workflow_id: 'lmis' })
  const app = express()
  app.use(express.json())
  app.locals.db = db
  app.use('/api', (await import('../src/routes/runHistory.js')).default)
  const srv = app.listen(0)
  const base = `http://127.0.0.1:${srv.address().port}/api`
  try {
    assert.equal((await (await fetch(`${base}/run-history`)).json()).length, 2)
    let r = await fetch(`${base}/run-history/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [done, run] }) })
    assert.equal(r.status, 409)
    assert.deepEqual((await r.json()).running, [run])
    r = await fetch(`${base}/run-history/${run}?running_ok=1`, { method: 'DELETE' })
    assert.deepEqual(await r.json(), { ok: true, deleted: 1 })
    r = await fetch(`${base}/run-history/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [done] }) })
    assert.deepEqual(await r.json(), { ok: true, deleted: 1 })
    assert.equal((await fetch(`${base}/run-history/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
  } finally { srv.close(); await db.destroy() }
})

test('two PCs: the same history on both (rows, pictures, deletes), with the PC that ran and the one that asked', async () => {
  const main = await makePC('RhMain', { slot: 1, schema: false }), comp = await makePC('RhComp', { slot: 2, schema: false })
  try {
    for (const pc of [main, comp]) {
      await (await migration()).up(pc.app)
      await pc.app.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('pause_reason'); t.text('log') })
      await pc.engine.refreshTables()
    }
    await main.app('sync_pcs').insert([{ pc_id: 'pcrhmain0000', name: 'FRONT-DESK', slot: 1 }, { pc_id: 'pcrhcomp0000', name: 'BACK-OFFICE', slot: 2 }])
    const h = await H()
    // The Companion asks for a run (its queue row, its id), the main PC's robot does it.
    const [runId] = await comp.app('automation_queue').insert({ status: 'pending', log: '[]' })
    await syncPair(main, comp)
    const hid = await h.begin(main.app, { run_id: runId, workflow_id: 'musaned_add_candidate', pc: 'FRONT-DESK' })
    await main.app('automation_queue').where('id', runId).update({ status: 'failed', pause_reason: 'x' })
    await h.finish(main.app, hid, { outcome: 'failed', reason: 'x' })
    await main.app('run_history_shots').insert({ history_id: hid, jpg: Buffer.from([0xff, 0xd8, 1, 2]), taken_at: 'x' })
    // A run the Companion did itself (the main PC was off): its own id, no clash.
    const own = await h.begin(comp.app, { run_id: null, workflow_id: 'lmis', pc: 'BACK-OFFICE' })
    
    await syncPair(main, comp)
    for (const pc of [main, comp]) {
      const rows = await h.list(pc.app)
      assert.deepEqual(rows.map(r => r.id).sort(), [hid, own].sort(), pc.name)
      const r = rows.find(x => x.id === hid)
      assert.equal(r.pc, 'FRONT-DESK'); assert.equal(r.asked_on, 'BACK-OFFICE'); assert.equal(r.outcome, 'failed')
      assert.equal(rows.find(x => x.id === own).asked_on, '')
      assert.deepEqual([...(await h.shotOf(pc.app, hid))], [0xff, 0xd8, 1, 2])
    }
    // Deleted on the Companion: gone on the main PC too, picture and all.
    assert.deepEqual(await h.remove(comp.app, [hid, own], { running_ok: true }), { deleted: 2, running: [] })

    await syncPair(main, comp)
    assert.equal((await h.list(main.app)).length, 0)
    assert.equal(await h.shotOf(main.app, hid), null)
  } finally { await main.close(); await comp.close() }
})
