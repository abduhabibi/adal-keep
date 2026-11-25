/**
 * askedRun.test.js — 2026-11-25, Main: a run the scanner had found waited for ever ("Waiting for Adal Browser to be
 * open"); a person's Continue did not count as a press. Now it is written on the run and wins.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-asked-'))
Object.assign(process.env, { SQLITE_PATH: path.join(tmp, 's.sqlite'), ADAL_NO_BROWSER_START: '1', ADAL_ROBOTS_IN_APP: '1', ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), SECRETS_PATH: path.join(tmp, 's.enc'), BRAVE_CDP_URL: 'http://127.0.0.1:9' })
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, Buffer.alloc(32, 1).toString('base64'))

test("a person's press on a run the scanner found is written on it, and its wait for the browser ends", async (t) => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true, postProcessResponse: (await import('../src/services/accountVault.js')).openRows })   // (as in knexfile)
  t.after(async () => { await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); setTimeout(() => process.exit(), 200).unref() })
  await db.migrate.latest({ directory: path.resolve('src/migrations') })
  const [pid] = await db('profiles').insert({ full_name: 'TEST ONE' })
  const now = new Date().toISOString()
  const [id] = await db('automation_queue').insert({ profile_id: pid, workflow_id: 'musaned_add_candidate', status: 'pending', pause_reason: 'Waiting for Adal Browser to be open', context: '{"a":1}', log: JSON.stringify([{ msg: 'Auto-discovered by scanner — first stage' }]), created_at: now, updated_at: now })
  const express = (await import('express')).default
  const app = express(); app.use(express.json()); app.locals.db = db
  app.use('/api', (await import('../src/routes/automations.js')).default)
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)) })
  t.after(() => s.close())
  // The route also starts the run; it ends at once here (no browser in tests).
  await fetch(`http://127.0.0.1:${s.address().port}/api/automations/${id}/resume`, { method: 'POST' }).catch(() => {})
  const row = await db('automation_queue').where({ id }).first()
  assert.ok(JSON.parse(row.context).asked_at > 0, 'the press is written on the run')
  assert.equal(JSON.parse(row.context).a, 1, 'the rest of its context stays')
  await new Promise(r => setTimeout(r, 4000))
  const after = await db('automation_queue').where({ id }).first()
  assert.notEqual(after.pause_reason, 'Waiting for Adal Browser to be open')
})
