// The Downloads folder is gone through only when it changed (docPipeline sweepNeeded); a new file wakes the queue.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-sweep-'))
const set = (ms) => fs.utimesSync(dir, ms / 1000, ms / 1000)
test('unchanged: not looked at; a new file: looked at (and once more while it may be written); every 10 minutes anyway', async () => {
  const { sweepNeeded } = await import('../src/services/docPipeline.js')
  let now = 1_800_000_000_000
  set(now - 3600e3)
  const need = sweepNeeded(dir, () => now)
  assert.equal(await need(), true, 'the first')
  now += 30e3; assert.equal(await need(), false)
  now += 30e3; assert.equal(await need(), false)
  set(now); now += 10e3
  assert.equal(await need(), true, 'a file came')
  now += 30e3; assert.equal(await need(), true, 'a minute after: again')
  now += 60e3; assert.equal(await need(), false)
  now += 10 * 60e3; assert.equal(await need(), true, 'ten minutes')
  process.env.ADAL_SWEEP_ALWAYS = '1'
  try { assert.equal(await need(), true) } finally { delete process.env.ADAL_SWEEP_ALWAYS }
})
test('a file put in line is read in about 1–2 s, though the queue is looked at every 10 s', async () => {
  const Q = await import('../src/services/ingestQueue.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('ingest_queue', t => { t.increments('id'); for (const c of ['filename', 'full_path', 'status', 'last_error', 'created_at', 'updated_at', 'started_at', 'finished_at', 'stage']) t.string(c); t.integer('file_size'); t.integer('attempts'); t.text('result') })
  await db.schema.createTable('files', t => { t.increments('id'); t.string('original_name'); t.integer('size'); t.integer('profile_field_id') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  let got = 0
  Q.startQueueWorker(db, async () => { got = Date.now(); return { ok: true, docType: 'x' } }, '[T]', null, 1)
  const f = path.join(dir, 'scan.jpg'); fs.writeFileSync(f, 'x')
  const t = Date.now()
  await Q.enqueueFile(db, f)
  while (!got && Date.now() - t < 8000) await new Promise(r => setTimeout(r, 50))
  assert.ok(got && got - t < 4000, got ? `${got - t} ms` : 'not read in 8 s')
})
