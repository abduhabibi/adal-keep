import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'
import { buildRows, backupProof, summaryText, eproMoves, parseWifi, notePresence, whoIsOn, pushIfDue, daySummary, dayCall, _resetForTest } from '../src/services/officeHealth.js'
import { registerDevice, liveDevices, _resetForTest as resetDevices } from '../src/services/remoteBrowsers.js'

const NOW = Date.parse('2026-11-22T08:00:00Z')
const H = 3600e3
const own = { name: 'MAIN-PC', employee: null, version: 'abc1234', wifi: null, lan: null }

test('a row per PC: the signed-in employee, else the PC name', () => {
  const devices = [{ id: 'a', name: 'DESK-1', at: NOW - 20e3, version: 'abc1234', wifi: 71, peers_total: 2, peers_ok: 1, peers_down: ['DESK-2'] }, { id: 'b', name: 'DESK-2', at: NOW - 5000 }]
  const replicas = [{ id: 'a', synced_at: new Date(NOW - 2 * H).toISOString() }, { id: 'b', synced_at: new Date(NOW - 50 * H).toISOString() }, { id: 'gone', name: 'OLD-PC', seen: new Date(NOW - 9 * 24 * H).toISOString() }]
  const rows = buildRows({ own, devices, replicas, who: (id) => (id === 'a' ? 'Selam' : null), now: NOW })
  assert.deepEqual(rows.map(r => r.name), ['MAIN-PC', 'Selam', 'DESK-2', 'OLD-PC'])
  const a = rows[1]
  assert.equal(a.online, true); assert.equal(a.wifi, 71); assert.deepEqual(a.lan, { ok: 1, total: 2, down: ['DESK-2'] })
  assert.equal(rows[3].online, false); assert.equal(rows[3].copy_at, null)
})

test('the morning line counts the PCs that hold a full copy and names the one behind by its employee', () => {
  const devices = [{ id: 'a', name: 'DESK-1', at: NOW }, { id: 'b', name: 'DESK-2', at: NOW }, { id: 'c', name: 'DESK-3', at: NOW }]
  const replicas = [{ id: 'a', synced_at: new Date(NOW - 3 * H).toISOString() }, { id: 'b', synced_at: new Date(NOW - 5 * H).toISOString() }, { id: 'c', synced_at: new Date(NOW - 55 * H).toISOString() }]
  const backup = { last_good_at: new Date(NOW - 2 * H).toISOString(), enabled: true }
  const rows = buildRows({ own, devices, replicas, backup, who: (id) => (id === 'c' ? 'Selam' : null), now: NOW })
  const p = backupProof(rows, backup, NOW)
  assert.equal(p.text, 'Backup OK – 3 PCs hold a full copy')
  assert.deepEqual(p.behind, ["Selam's PC is 2 days behind"])
  assert.equal(p.level, 'notice')
  const all = backupProof(rows.slice(0, 3), backup, NOW)
  assert.equal(all.ok, true)
  assert.equal(backupProof(rows.slice(0, 1), backup, NOW).text, 'Backup OK – 1 PC holds a full copy')
})

test('no new backup for days is a warning; a PC with no copy yet is named', () => {
  const rows = buildRows({ own, devices: [{ id: 'a', name: 'DESK-1', at: NOW }], replicas: [], now: NOW })
  const p = backupProof(rows, { last_good_at: new Date(NOW - 3 * 24 * H).toISOString(), enabled: true }, NOW)
  assert.equal(p.level, 'warn'); assert.equal(p.text, 'No new backup for 3 days')
  assert.deepEqual(p.behind, ['DESK-1 has no copy yet'])
  assert.equal(backupProof(rows, { last_good_at: null, enabled: true }, NOW).text, 'No backup yet')
})

test('who is signed in: remembered 10 minutes, then the PC name is used', () => {
  _resetForTest()
  notePresence('a', 'Selam', NOW)
  assert.equal(whoIsOn('a', NOW + 60e3), 'Selam')
  assert.equal(whoIsOn('a', NOW + 11 * 60e3), null)
  notePresence('a', '', NOW); assert.equal(whoIsOn('a', NOW), null)
})

test('the Companion heartbeat carries version, Wi-Fi and what it reaches', () => {
  resetDevices()
  const body = { token: 'x'.repeat(20), name: 'DESK-1', version: 'abc1234', wifi: 64, peers_total: 3, peers_ok: 2, peers_down: ['DESK-3'] }
  assert.equal(registerDevice({ id: 'a' }, '192.168.1.5', body).ok, true)
  const d = liveDevices()[0]
  assert.equal(d.version, 'abc1234'); assert.equal(d.wifi, 64); assert.equal(d.peers_ok, 2); assert.deepEqual(d.peers_down, ['DESK-3'])
  assert.equal(d.token, undefined)
  // An older Companion says none of it.
  registerDevice({ id: 'b' }, '192.168.1.6', { token: 'y'.repeat(20) })
  assert.equal(liveDevices().find(x => x.id === 'b').peers_total, null)
})

test('Wi-Fi signal from netsh and /proc/net/wireless', () => {
  assert.equal(parseWifi('    Name : Wi-Fi\n    Signal                 : 83%\n', 'win32'), 83)
  assert.equal(parseWifi('', 'win32'), null)
  assert.equal(parseWifi('Inter-| sta\n face | tus\n wlan0: 0000   35.  -60.  -256        0\n', 'linux'), 50)
})

test('end-of-day words', () => {
  assert.equal(summaryText({ added: 12, epro: 5, waiting: 2 }), 'Today: 12 profiles added, 5 moved to EPRO, 2 waiting on you')
  assert.equal(summaryText({ added: 1 }), 'Today: 1 profile added')
  assert.equal(summaryText({}), 'Today: a quiet day')
})

test('moved to EPRO today: the step went from todo to active/done', () => {
  const row = (epro) => JSON.stringify({ steps: { epro } })
  const before = new Map([[1, row('todo')], [2, row('done')], [3, row('todo')]])
  assert.equal(eproMoves([{ profile_id: 1, data: row('active') }, { profile_id: 2, data: row('done') }, { profile_id: 3, data: row('todo') }, { profile_id: 4, data: row('done') }], before), 1)
})

async function db() {
  const k = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await k.schema.createTable('settings', t => { t.increments('id'); t.string('key'); t.text('value'); t.string('created_at'); t.string('updated_at') })
  await k.schema.createTable('profiles', t => { t.increments('id'); t.string('created_at'); t.string('deleted_at') })
  await k.schema.createTable('profile_days', t => { t.integer('profile_id'); t.string('day'); t.text('data'); t.string('updated_at') })
  return k
}

test('the card: counts from the database, shown from 17:00', async () => {
  const k = await db()
  await k('profiles').insert([{ created_at: '2026-11-22T07:00:00.000Z' }, { created_at: '2026-11-22 09:00:00' }, { created_at: '2026-11-21T09:00:00Z' }, { created_at: '2026-11-22T10:00:00Z', deleted_at: '2026-11-22' }])
  const row = (epro) => JSON.stringify({ steps: { epro } })
  await k('profile_days').insert([{ profile_id: 1, day: '2026-11-21', data: row('todo') }, { profile_id: 1, day: '2026-11-22', data: row('active') }])
  const s = await daySummary(k, new Date(2026, 10, 22, 16, 59))
  assert.equal(s.added, 2); assert.equal(s.epro, 1); assert.equal(s.show, false)
  assert.equal((await daySummary(k, new Date(2026, 10, 22, 17, 0))).show, true)
  await k.destroy()
})

test('one push a day at 17:30, never before, never twice; its text is a call for the hour after', async () => {
  const k = await db()
  const sent = []
  const push = async (_db, data) => { sent.push(data); return { sent: 1 } }
  assert.equal((await pushIfDue(k, new Date(2026, 10, 22, 17, 29), { push })).sent, false)
  const r = await pushIfDue(k, new Date(2026, 10, 22, 17, 30), { push })
  assert.equal(r.sent, true); assert.equal(sent.length, 1); assert.deepEqual(sent[0], { type: 'attention' })
  assert.equal((await pushIfDue(k, new Date(2026, 10, 22, 17, 45), { push })).sent, false)
  assert.equal(sent.length, 1)
  assert.equal(dayCall(new Date(2026, 10, 22, 17, 40)).title, r.text)
  assert.equal(dayCall(new Date(2026, 10, 22, 18, 31)), null)
  // Tomorrow: again.
  assert.equal((await pushIfDue(k, new Date(2026, 10, 23, 17, 31), { push })).sent, true)
  await k.destroy()
})
