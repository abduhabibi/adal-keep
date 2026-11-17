import test from 'node:test'
import assert from 'node:assert/strict'
import { stagePercent, percentNow, readingNow } from '../src/services/ingestQueue.js'

test('each reading step has its percent, in order', () => {
  const steps = ['starting', 'JEV is looking at what the picture holds', 'reading the document',
    'asking Gemini (gemini-2.5-flash)', 'reading every detail of the passport', 'saving it to Amina Ali']
  const pcts = steps.map(stagePercent)
  assert.deepEqual(pcts, [5, 15, 30, 45, 70, 90])
  assert.equal(stagePercent('something new'), null)
})

test('the bar creeps toward the next step but never reaches it', () => {
  const at = 1_000_000
  assert.equal(percentNow({ pct: 45, at }, at), 45)
  assert.equal(percentNow({ pct: 45, at }, at + 10_000), 55)
  assert.equal(percentNow({ pct: 45, at }, at + 600_000), 68)
  assert.equal(percentNow(undefined), 0)
})

test('reading now: the file being read and how many wait', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  const { up } = await import('../src/migrations/021_ingest_queue.js')
  await up(db)
  await (await import('../src/migrations/032_ingest_queue_progress.js')).up(db)
  const now = new Date().toISOString()
  await db('ingest_queue').insert([
    { filename: 'passport.pdf', full_path: 'x', status: 'processing', stage: 'reading the document', created_at: now },
    { filename: 'photo.jpg', full_path: 'y', status: 'pending', created_at: now },
    { filename: 'old.pdf', full_path: 'z', status: 'done', created_at: now },
  ])
  const r = await readingNow(db)
  assert.equal(r.reading.length, 1)
  assert.equal(r.reading[0].filename, 'passport.pdf')
  assert.equal(r.waiting, 1)
  await db.destroy()
})
