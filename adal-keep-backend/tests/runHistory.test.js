// The robot history (asked on 2026-11-22): every try of a run is a row — who,
// which PC and site, when, how long, how it ended, the step it stopped at, and
// a small picture of the tab at the stop. 30 days, then gone.
import test from 'node:test'
import assert from 'node:assert/strict'

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('pause_reason'); t.text('log') })
  await (await import('../src/migrations/065_run_history.js')).up(db)
  return db
}
const H = () => import('../src/services/runHistory.js')

async function bigJpeg(w = 1600, h = 1000) {
  const sharp = (await import('sharp')).default
  // noisy, so it does not compress to nothing
  const raw = Buffer.alloc(w * h * 3); for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919 + (i >> 3)) & 255
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()
}

test('a failed run: who, PC, site, step, outcome, duration and a small picture', async () => {
  const db = await setup()
  const h = await H()
  const id = await h.begin(db, { run_id: 7, workflow_id: 'musaned_add_candidate', profile_id: 3, profile_name: 'Almaz T', employee: 'Sara', pc: 'PC-FRONT', account: 'Main', started_at: '2026-11-22T08:00:00.000Z' })
  await db('automation_queue').insert({ id: 7, status: 'failed', pause_reason: 'Worker card not found (after 1 attempts)', log: JSON.stringify([{ msg: '✓ Signed in' }, { msg: 'Searching her passport' }, { msg: '⛔ nothing' }]) })
  const page = { isClosed: () => false, screenshot: async () => bigJpeg() }
  await db('run_history').where('id', id).update({ started_at: new Date(Date.now() - 90_000).toISOString() })
  await h.finishRun(db, 7, page)
  const [row] = await h.list(db)
  assert.equal(row.site, 'Musaned'); assert.equal(row.employee, 'Sara'); assert.equal(row.pc, 'PC-FRONT'); assert.equal(row.profile_name, 'Almaz T')
  assert.equal(row.outcome, 'failed'); assert.equal(row.reason, 'she was not found on the site')
  assert.equal(row.step, 'Searching her passport')
  assert.ok(row.duration_s >= 89 && row.duration_s <= 95)
  assert.equal(row.has_shot, true)
  const jpg = await h.shotOf(db, id)
  assert.ok(jpg.length <= h.SHOT_MAX, `picture is ${jpg.length} bytes`)
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8)
  await db.destroy()
})

test('a run that finished has no picture; a closed tab does not break the history', async () => {
  const db = await setup()
  const h = await H()
  const a = await h.begin(db, { run_id: 1, workflow_id: 'lmis' })
  await db('automation_queue').insert({ id: 1, status: 'done', log: '[]' })
  await h.finishRun(db, 1, { isClosed: () => false, screenshot: async () => { throw new Error('must not be taken') } })
  const b = await h.begin(db, { run_id: 2, workflow_id: 'wafid_book' })
  await db('automation_queue').insert({ id: 2, status: 'failed', pause_reason: 'x', log: '[]' })
  await h.finishRun(db, 2, { isClosed: () => true })
  const rows = await h.list(db)
  assert.deepEqual(rows.map(r => [r.id, r.outcome, r.has_shot]).sort(), [[a, 'done', false], [b, 'failed', false]].sort())
  assert.equal(rows.find(r => r.id === a).site, 'LMIS')
  assert.equal(await h.shotOf(db, a), null)
  await db.destroy()
})

test('rows older than 30 days go with their pictures; newer and running ones stay', async () => {
  const db = await setup()
  const h = await H()
  const now = Date.parse('2026-12-31T00:00:00Z')
  const old = await h.begin(db, { run_id: 1, workflow_id: 'lmis', started_at: '2026-11-20T00:00:00.000Z' })
  const fresh = await h.begin(db, { run_id: 2, workflow_id: 'lmis', started_at: '2026-12-20T00:00:00.000Z' })
  const stuck = await h.begin(db, { run_id: 3, workflow_id: 'lmis', started_at: '2026-10-01T00:00:00.000Z' })
  await h.finish(db, old, { outcome: 'failed', reason: 'x', ended_at: '2026-11-20T00:01:00.000Z', page: { screenshot: async () => bigJpeg(400, 300) } })
  await h.finish(db, fresh, { outcome: 'done', ended_at: '2026-12-20T00:01:00.000Z' })
  assert.ok(await h.shotOf(db, old))
  assert.equal(await h.prune(db, now), 1)
  assert.deepEqual((await h.list(db)).map(r => r.id).sort(), [fresh, stuck].sort())
  assert.equal(await h.shotOf(db, old), null)
  await db.destroy()
})

test('filters: site, outcome, employee, PC, text; and the choices to filter by', async () => {
  const db = await setup()
  const h = await H()
  const mk = async (o, outcome, reason = '') => { const id = await h.begin(db, o); await h.finish(db, id, { outcome, reason }) }
  await mk({ workflow_id: 'musaned_add_candidate', employee: 'Sara', pc: 'A', profile_name: 'Almaz' }, 'done')
  await mk({ workflow_id: 'lmis', employee: 'Abel', pc: 'B', profile_name: 'Hana' }, 'failed', 'Worker card not found')
  await mk({ workflow_id: 'wafid_book', employee: 'Abel', pc: 'A', profile_name: 'Hana' }, 'cancelled')
  await mk({ kind: 'move', workflow_id: 'enjazplus', workflow: 'Move from EnjazPlus', site: 'EnjazPlus', employee: 'Sara', pc: 'A' }, 'done')
  assert.equal((await h.list(db)).length, 4)
  assert.equal((await h.list(db, { site: 'LMIS' })).length, 1)
  assert.equal((await h.list(db, { employee: 'Abel' })).length, 2)
  assert.equal((await h.list(db, { employee: 'Abel', pc: 'A' })).length, 1)
  assert.equal((await h.list(db, { outcome: 'done' })).length, 2)
  assert.equal((await h.list(db, { q: 'hana' })).length, 2)
  assert.equal((await h.list(db, { q: 'not found' })).length, 1)
  assert.equal((await h.list(db, { q: '%' })).length, 0)
  assert.equal((await h.list(db, { limit: 2 })).length, 2)
  const c = await h.choices(db)
  assert.deepEqual(c.sites.sort(), ['EnjazPlus', 'LMIS', 'Musaned', 'Wafid'])
  assert.deepEqual(c.employees, ['Abel', 'Sara'])
  assert.deepEqual(c.pcs, ['A', 'B'])
  await db.destroy()
})

test('a restart closes what was running; the picture is squeezed under 100 KB', async () => {
  const db = await setup()
  const h = await H()
  await h.begin(db, { run_id: 9, workflow_id: 'lmis' })
  await h.closeStale(db)
  const [r] = await h.list(db)
  assert.equal(r.outcome, 'stopped'); assert.match(r.reason, /restarted/)
  const small = await h.compress(await bigJpeg(3000, 2000))
  assert.ok(small.length <= h.SHOT_MAX)
  await db.destroy()
})
