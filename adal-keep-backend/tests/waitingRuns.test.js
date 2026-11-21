/**
 * waitingRuns.test.js — a run sent back with "Waiting for Adal Browser to be
 * open" waits its 2 minutes like a retry. Before, the queue only held back
 * "Retry" runs, so it was claimed again at once and logged "started" ~1,188 times.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-waiting-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'keys')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'

const { readyJobsQuery } = await import('../src/services/worker.js')

test('waiting and retry runs are held back until their time; others start', async () => {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('pause_reason'); t.string('updated_at') })
  const later = new Date(Date.now() + 2 * 60000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  await db('automation_queue').insert([
    { id: 1, status: 'pending', pause_reason: null, updated_at: past },
    { id: 2, status: 'pending', pause_reason: 'Waiting for Adal Browser to be open', updated_at: later },
    { id: 3, status: 'pending', pause_reason: 'Waiting for Adal Browser to be open', updated_at: past },
    { id: 4, status: 'pending', pause_reason: 'Retry 1/3 in 30s', updated_at: later },
    { id: 5, status: 'pending', pause_reason: 'Retry 1/3 in 30s', updated_at: past },
    { id: 6, status: 'pending', pause_reason: 'Something else', updated_at: later },
    { id: 7, status: 'paused', pause_reason: null, updated_at: past },
  ])
  const ids = (await readyJobsQuery(db).orderBy('id')).map(r => r.id)
  assert.deepEqual(ids, [1, 3, 5, 6])
  await db.destroy()
})
