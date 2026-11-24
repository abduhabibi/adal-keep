// Adal Keep without its robots (the default since 2026-11-24): they run in Adal Robots.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'
delete process.env.ADAL_ROBOTS_IN_APP
process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adal-off-')), 't.sqlite')
const knex = (await import('knex')).default
const B = await import('../src/services/browser.js')
const W = await import('../src/services/worker.js')

test('no robot browser: never started, never connected to', async () => {
  assert.equal(await B.openBrowserIfAny(), null)
  await assert.rejects(B.getBrowser(), /Adal Robots/)
  assert.equal(B.startBrowserQuietly(), undefined)
})

test('a robot button puts the run in line for Adal Robots; nothing runs it here', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true, migrations: { directory: './src/migrations' } })
  try {
    await db.migrate.latest()
    const [id] = await db('automation_queue').insert({ profile_id: 1, workflow_id: 'musaned_add', status: 'pending', log: '[]' })
    await W.drainQueue(db)
    const s = await W.dispatchRun(db, id)
    assert.equal(s.in_line, true)
    const row = await db('automation_queue').where('id', id).first()
    assert.equal(row.status, 'pending', 'it waits in the queue')
    assert.equal(row.pause_reason, 'In line for Adal Robots')
    W.startWorker(db)   // no poll, no agency manager
    assert.equal(W.queueSnapshot().running.length, 0)
  } finally { W.stopWorker(); await db.destroy() }
})
