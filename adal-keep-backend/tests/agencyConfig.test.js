import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agcfg-'))
process.env.ADAL_AGENCY_CONFIG_CACHE = path.join(tmp, 'agency-config.json')
process.env.ADAL_FLAGS_FILE = path.join(tmp, 'flags.json')
delete process.env.ADAL_FLAG_AGENCY_CONFIG
delete process.env.ADAL_FLAG_AGENCY_SIGNUP

const { default: knex } = await import('knex')
const C = await import('../src/services/agencyConfig.js')

const opened = []
after(() => Promise.all(opened.map(d => d.destroy())))
async function db() {
  const d = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await d.schema.createTable('settings', t => { t.string('key'); t.text('value'); t.timestamps(true, true) })
  await d.schema.createTable('staff_roles', t => { t.increments('id'); t.string('name'); t.string('preset'); t.text('perms'); t.timestamps(true, true) })
  opened.push(d)
  return d
}
const record = (v, extra = {}) => ({ version: v, updated_at: `2026-11-23T10:0${v}:00Z`, config: { agency_email: 'office@abc.et', lmis_sms_number: '+251 911-000-111', features: { new_dashboard: true, bogus: true }, staff_roles: [{ name: 'Cashier', perms: { run_robots: true, evil: true } }], ...extra } })

test('everything is off until the flag is on', async () => {
  const d = await db()
  assert.equal(C.localFlag('agency_config'), false)
  assert.deepEqual(await C.pullAgencyConfig(d, async () => { throw new Error('must not ask') }, 'a1'), { skipped: 'flag off' })
  assert.equal(C.featureOn('new_dashboard'), false)
})

test('normalize keeps only known, cleaned fields', () => {
  const n = C.normalizeConfig(record(1, { agency_email: 'not-an-email' }).config)
  assert.equal(n.agency_email, null)
  assert.equal(n.lmis_sms_number, '+251911000111')
  assert.deepEqual(n.features, { new_dashboard: true })
  assert.equal(n.staff_roles[0].perms.evil, undefined)
  assert.equal(n.staff_roles[0].perms.run_robots, true)
  assert.equal(n.staff_roles[0].perms.delete_profiles, false)
})

test('pull applies a new version, caches it, and works offline from the cache', async () => {
  process.env.ADAL_FLAG_AGENCY_CONFIG = '1'
  const d = await db()
  const calls = []
  const ask = async (m, p) => { calls.push(p); return [record(1)] }
  const r = await C.pullAgencyConfig(d, ask, 'a1')
  assert.equal(r.version, 1)
  assert.ok(r.applied.includes('agency_email'))
  assert.equal((await d('settings').where({ key: 'agency_email' }).first()).value, 'office@abc.et')
  assert.equal((await d('settings').where({ key: 'lmis_sms_number' }).first()).value, '+251911000111')
  assert.equal((await d('staff_roles').where({ name: 'Cashier' }).first()).name, 'Cashier')
  assert.equal(C.featureOn('new_dashboard'), true)
  assert.equal(C.featureOn('remote_setup'), false)   // not set → its default
  assert.ok(fs.existsSync(process.env.ADAL_AGENCY_CONFIG_CACHE))
  // the same version again: nothing re-applied
  assert.equal((await C.pullAgencyConfig(d, ask, 'a1')).same, true)
  // offline: the cache answers, nothing breaks
  const off = await C.pullAgencyConfig(d, async () => { throw new Error('fetch failed') }, 'a1')
  assert.equal(off.offline, true)
  assert.equal(C.featureOn('new_dashboard'), true)
  // Adal flips the switch: a release is not needed
  await C.pullAgencyConfig(d, async () => [record(2, { features: { new_dashboard: false } })], 'a1')
  assert.equal(C.featureOn('new_dashboard'), false)
})

test('a fresh process reads the last good copy from the cache file', async () => {
  const j = JSON.parse(fs.readFileSync(process.env.ADAL_AGENCY_CONFIG_CACHE, 'utf8'))
  assert.equal(j.version, 2)
})

test('sign-up checks the details and creates the record as "new"', async () => {
  assert.match(C.cleanSignup({ name: '', phone: '0911223344', email: 'a@b.et' }).error, /name/)
  assert.match(C.cleanSignup({ name: 'ABC', phone: 'x', email: 'a@b.et' }).error, /Phone/)
  assert.match(C.cleanSignup({ name: 'ABC', phone: '0911223344', email: 'nope' }).error, /mail/)
  const d = await db()
  const sent = []
  const ask = async (m, p, b) => { sent.push([m, p, b]); return null }
  assert.deepEqual(await C.signupState(d, ask, 'a1'), { status: 'none' })
  const r = await C.sendSignup(d, ask, { name: ' ABC Agency ', phone: '0911223344', email: 'office@abc.et' }, '123455')
  assert.equal(r.status, 'new')
  assert.equal(sent[0][1], '/rest/v1/rpc/agency_sign_up')
  assert.equal(sent[0][2].p_name, 'ABC Agency')
  assert.equal((await d('settings').where({ key: 'agency_email' }).first()).value, 'office@abc.et')
  // Admin pressed Ready: the next look says so
  const ready = await C.signupState(d, async () => [{ name: 'ABC Agency', status: 'ready', ready_at: 'x' }], 'a1')
  assert.equal(ready.status, 'ready')
  // offline: the last known status
  assert.equal((await C.signupState(d, async () => { throw new Error('offline') }, 'a1')).status, 'ready')
})
