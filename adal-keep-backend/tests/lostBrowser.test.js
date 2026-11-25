/** lostBrowser.test.js — 2026-11-25: a run whose browser was lost before anything was sent goes back in line once; never twice, never after something was sent. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lost-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'v.key')
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, Buffer.alloc(32, 1).toString('base64'))
const { backInLine, noteSent, browserLost } = await import('../src/services/lostBrowser.js')
const { openRows } = await import('../src/services/accountVault.js')

const req = (method, url, type = 'xhr') => ({ method: () => method, url: () => url, resourceType: () => type })
test('what counts as sent', () => {
  const p = {}
  for (const r of [req('GET', 'https://tawtheeq.musaned.com.sa/x'), req('POST', 'https://accounts.wahid.sa/auth/realms/x'), req('POST', 'https://www.google.com/recaptcha/api2/userverify'), req('POST', 'https://lmis.gov.et/api/auth/login'), req('POST', 'https://x.maze.co/p', 'ping')]) noteSent(p, r)
  assert.equal(p.__adalSent || '', '')
  noteSent(p, req('POST', 'https://api-tawtheeq.musaned.com.sa/api/candidates'))
  assert.match(p.__adalSent, /POST api-tawtheeq/)
  for (const m of ['Requesting main frame too early!', 'Protocol error (Runtime.callFunctionOn): Target closed', 'Navigating frame was detached']) assert.equal(browserLost({}, m), true, m)
  assert.equal(browserLost({ isClosed: () => false, browser: () => ({ connected: true }) }, 'HR Pool was not there'), false)
})
test('back in line once, with nothing sent', async (t) => {
  const db = (await import('knex')).default({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, postProcessResponse: openRows, pool: { min: 1, max: 1 } })
  t.after(async () => { await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }) })
  await db.schema.createTable('automation_queue', x => { x.increments('id'); x.string('status'); x.text('context'); x.string('pause_reason'); x.string('updated_at') })
  const [id] = await db('automation_queue').insert({ status: 'running', context: '{"account_id":3}' })
  const row = () => db('automation_queue').where({ id }).first(), E = 'Target closed'
  assert.equal(await backInLine(db, { id }, { __adalSent: 'POST x' }, E), '', 'something was sent')
  assert.equal(await backInLine(db, { id }, {}, 'HR Pool was not there'), '', 'another reason')
  assert.match(await backInLine(db, { id }, {}, E), /back in line, once/)
  assert.equal((await row()).status, 'pending'); assert.equal(JSON.parse((await row()).context).account_id, 3)
  await db('automation_queue').where({ id }).update({ status: 'running' })
  assert.equal(await backInLine(db, { id }, {}, E), '', 'never a second time')
  await db('automation_queue').where({ id }).update({ status: 'cancelled', context: '{}' })
  assert.equal(await backInLine(db, { id }, {}, E), '', 'stopped by a person')
})
test('"internet was down" only when nothing answers, twice', async () => {
  const { internetUp, withInternetCheck } = await import('../src/services/runOutcome.js')
  let n = 0
  assert.equal(await internetUp(async () => { if (++n < 3) throw new Error('lost') }), true, 'one of three answers')
  n = 0
  assert.equal(await internetUp(async () => { if (++n < 5) throw new Error('lost') }), true, 'the second time')
  assert.equal(await internetUp(async () => { throw new Error('x') }), false)
  assert.match(await withInternetCheck('net::ERR_TIMED_OUT', async () => {}), /was working/)
})
