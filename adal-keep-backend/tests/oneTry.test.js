/**
 * oneTry.test.js — 2026-11-25, an agency's main PC: two girls' Musaned runs went on in turn for hours, 10 minutes each.
 * A run stopped at 10 minutes is 'cancelled', and a cancelled run was not counted: the scan (every 2 minutes) queued
 * her again. Now: one try, then nothing by itself until a person presses it. Database in memory, no browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { rmTmp } from './helpers/chrome.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-onetry-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'
process.env.ADAL_ROBOTS_IN_APP = '0'   // nothing queued here is run
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, (await import('crypto')).randomBytes(32).toString('base64'))

const knex = (await import('knex')).default
const db = knex({ client: 'sqlite3', connection: { filename: path.join(tmp, 'x.sqlite') }, useNullAsDefault: true })
await db.migrate.latest({ directory: path.resolve(import.meta.dirname, '..', 'src', 'migrations') })
test.after(async () => { await db.destroy(); rmTmp(tmp); setTimeout(() => process.exit(), 200).unref() })

const { wantsMusaned } = await import('../src/services/firstStage.js')
const { scanOnce } = await import('../src/services/autoScanner.js')
const W = await import('../src/services/worker.js')
const { LIMIT_NOTE } = await import('../src/services/runLimit.js')
const ENDS = [['cancelled', LIMIT_NOTE], ['cancelled', 'Cancelled by user'], ['failed', 'the page did not open'], ['done', null], ['paused', 'awaiting-human-save'], ['pending', null], ['running', null]]
const OLD = new Date(Date.now() - 30 * 3600e3).toISOString()

test('Musaned: Add candidate is queued by itself once, however the first run ended and however long ago', () => {
  assert.equal(wantsMusaned({}, {}, true), true)
  for (const [status, pause_reason] of ENDS) for (const updated_at of [OLD, new Date().toISOString()]) {
    assert.equal(wantsMusaned({}, { musaned_add_candidate: { id: 1, status, pause_reason, updated_at } }, true), false, `${status} (${pause_reason})`)
  }
})

const locked = (await import('../src/services/subscription.js')).isAppLocked()
test('the scan: a run stopped at 10 minutes is not queued again, scan after scan', { skip: locked && 'this copy of Adal Keep is locked (its trial is over): the scan does nothing' }, async () => {
  await db('lmis_accounts').insert({ name: 'A', phone: '0911', password: 'x', is_default: 1 }).catch(() => db('lmis_accounts').insert({ name: 'A', login_value: '0911', password: 'x' }))
  const girl = async (n) => {
    const [id] = await db('profiles').insert({ full_name: `TEST GIRL ${n}`, first_name: 'TEST', last_name: n, destination_country: 'Kuwait', labor_id: `L${n}`, order_id: `O${n}` })
    for (const name of ['Passport', 'Photo', 'Full Body Photo', 'Slip']) {
      const [f] = await db('profile_fields').insert({ profile_id: id, name, field_type: 'file' }).catch(() => db('profile_fields').insert({ profile_id: id, name }))
      await db('files').insert({ profile_field_id: f, path: `/x/${name}`, original_name: name, filename: name }).catch(() => db('files').insert({ profile_field_id: f, path: `/x/${name}` }))
    }
    return id
  }
  const a = await girl('ONE'), b = await girl('TWO')
  await db('settings').insert({ key: 'first_stage_auto', value: '0' }).catch(() => {})
  const police = () => db('automation_queue').where({ workflow_id: 'police_certificate' })
  await scanOnce(db)
  assert.equal((await police()).length, 2, 'each queued once')
  for (const [status, why] of ENDS) {
    await police().update({ status, pause_reason: why, updated_at: OLD })
    await scanOnce(db); await scanOnce(db)
    assert.equal((await police()).length, 2, `${status} (${why}): not queued again`)
  }
  void a; void b
})

test('stopped at 10 minutes is the end: nothing the worker does puts it back in line', async () => {
  const pid = (await db('profiles').first('id')).id
  const now = new Date().toISOString()
  const [id] = await db('automation_queue').insert({ profile_id: pid, workflow_id: 'musaned_add_candidate', status: 'running', current_step: 0, context: '{}', log: '[]', created_at: now, updated_at: now })
  let closed = false
  await W.stopAtLimit(db, { id, workflow_id: 'musaned_add_candidate' }, { close: async () => { closed = true } })
  const row = () => db('automation_queue').where('id', id).first()
  assert.equal((await row()).status, 'cancelled'); assert.equal((await row()).pause_reason, LIMIT_NOTE); assert.ok(closed)
  for (const f of ['reviveSignIns', 'closeSavedRuns', 'adoptWaitingTabs']) await W[f]?.(db)   // (an older version has not all of them)
  assert.equal(await W.readyJobsQuery(db).where('id', id).first(), undefined, 'not ready to start')
  assert.equal((await row()).status, 'cancelled')
})

test('her slip found missing: fetched by itself once, then a person presses it', async () => {
  const { queueWafidSlip } = await import('../src/services/wafidStatus.js')
  const pid = (await db('profiles').first('id')).id
  // (Queued as in line; nothing runs it here: the worker is not started.)
  const now = new Date().toISOString()
  await db('automation_queue').insert({ profile_id: pid, workflow_id: 'wafid_slip', status: 'cancelled', pause_reason: LIMIT_NOTE, current_step: 0, context: '{}', log: '[]', created_at: now, updated_at: now })
  assert.equal((await queueWafidSlip(db, pid, 'missing')).queued, false)
})
