/**
 * standby.test.js — every Adal Companion is a full Adal Keep in waiting
 * (asked on 2026-11-20). Standing in for the main PC, it is reached through
 * adal-companion.exe: an office computer is never taken for this PC; the
 * returning main PC reads only what was done meanwhile, with its token; the
 * newest change wins and nothing is deleted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import knex from 'knex'

process.env.ADAL_BEHIND_COMPANION = '1'
process.env.ADAL_MERGE_TOKEN = 't'.repeat(48)
const gate = await import('../src/services/networkGate.js')
const { exportAll, newerValues } = await import('../src/services/branchMerge.js')

const req = (sock, headers = {}) => ({ socket: { remoteAddress: sock }, headers })

test('behind the Companion: an office computer is who it is, never this PC', () => {
  assert.equal(gate.ipOf(req('127.168.1.20', { 'x-adal-real-ip': '192.168.1.20' })), '192.168.1.20')
  assert.equal(gate.isLocal(req('127.168.1.20', { 'x-adal-real-ip': '192.168.1.20' })), false)
  // Without the door's word: still not this PC.
  assert.equal(gate.isLocal(req('127.168.1.20')), false)
  // Only the door's loopback addresses are believed: a computer on the network cannot claim one.
  assert.equal(gate.ipOf(req('192.168.1.30', { 'x-adal-real-ip': '127.0.0.1' })), '192.168.1.30')
  // This PC's own window (straight to 127.0.0.1): this PC.
  assert.equal(gate.isLocal(req('127.0.0.1', { 'x-adal-real-ip': '192.168.1.30' })), true)
})

test('the returning main PC reads with its token only', () => {
  assert.equal(gate.mergeTokenOk(req('1.2.3.4', { 'x-adal-merge': 't'.repeat(48) })), true)
  assert.equal(gate.mergeTokenOk(req('1.2.3.4', { 'x-adal-merge': 'u'.repeat(48) })), false)
  assert.equal(gate.mergeTokenOk(req('1.2.3.4', {})), false)
})

test('the newest change wins, only after the Companion stood in', () => {
  const since = '2026-11-20T08:00:00Z'
  const theirs = { updated_at: '2026-11-20T09:00:00Z' }
  const values = { religion: 'Muslim', phone_number: '0911' }
  assert.deepEqual(newerValues(theirs, { updated_at: '2026-11-20T07:00:00Z', religion: 'Christian', phone_number: '0911' }, values, since), { religion: 'Muslim' })
  // Changed on the main PC later: the main PC's stays.
  assert.deepEqual(newerValues(theirs, { updated_at: '2026-11-20T10:00:00Z', religion: 'Christian' }, values, since), {})
  // Not changed while it stood in: nothing.
  assert.deepEqual(newerValues({ updated_at: '2026-11-20T07:30:00Z' }, { updated_at: '2026-11-20T07:00:00Z', religion: 'X' }, values, since), {})
  // A plain branch merge (no since): only empty details, as before.
  assert.deepEqual(newerValues(theirs, { updated_at: '2026-11-20T07:00:00Z', religion: 'Christian' }, values, null), {})
})

test('only what was done while it stood in is sent back', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('brokers', t => { t.increments('id'); t.string('name'); t.string('address'); t.string('contact1'); t.string('contact2'); t.string('notes') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('passport_number'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name'); t.string('data_type'); t.integer('is_permanent'); t.string('value_text'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('mimetype'); t.integer('size'); t.string('path'); t.string('created_at') })
  const old = '2026-11-19T10:00:00Z', fresh = '2026-11-20T09:00:00Z'
  await db('profiles').insert([
    { full_name: 'Old', passport_number: 'EP1', created_at: old, updated_at: old },
    { full_name: 'Edited', passport_number: 'EP2', created_at: old, updated_at: fresh },
    { full_name: 'New', passport_number: 'EP3', created_at: fresh, updated_at: fresh },
    { full_name: 'Doc added', passport_number: 'EP4', created_at: old, updated_at: old },
  ])
  await db('profile_fields').insert({ profile_id: 4, name: 'Passport', created_at: old, updated_at: fresh })
  const all = await exportAll(db)
  assert.equal(all.profiles.length, 4)
  const since = await exportAll(db, { since: '2026-11-20T08:00:00Z' })
  assert.deepEqual(since.profiles.map(p => p.full_name).sort(), ['Doc added', 'Edited', 'New'])
  await db.destroy()
})

test('the server a Companion keeps never carries the agency\'s data', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const { spawnSync } = await import('child_process')
  const { BUNDLE_EXCLUDES, TAR: tar } = await import('../src/routes/standby.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'))
  const put = (p, s = 'x') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s) }
  put('runtime/node.exe'); put('backend/server.js'); put('backend/src/a.js'); put('backend/node_modules/k/index.js')
  put('backend/data.sqlite'); put('backend/data/SafeStorage/passport.jpg'); put('backend/data/pc-access.json')
  put('backend/uploads/u.jpg'); put('backend/node_modules.before-fix/x.js'); put('backend/logs/server.log')
  const out = path.join(root, '..', path.basename(root) + '.tgz')
  const r = spawnSync(tar, ['-czf', out, '-C', root, ...BUNDLE_EXCLUDES.flatMap(x => ['--exclude', x]), 'runtime', 'backend'])
  assert.equal(r.status, 0, String(r.stderr))
  const list = spawnSync(tar, ['-tzf', out]).stdout.toString().split(/\r?\n/).filter(Boolean).map(s => s.replace(/\/$/, ''))
  for (const want of ['runtime/node.exe', 'backend/server.js', 'backend/src/a.js', 'backend/node_modules/k/index.js']) assert.ok(list.includes(want), want)
  for (const never of ['backend/data.sqlite', 'backend/data/SafeStorage/passport.jpg', 'backend/data/pc-access.json', 'backend/uploads/u.jpg', 'backend/node_modules.before-fix/x.js', 'backend/logs/server.log'])
    assert.ok(!list.some(x => x === never || x.startsWith(never + '/')), never)
})
