// Safety: backups that do not need the night, the newest good backup (a
// Companion's counts), and a Companion's locked copy that a restore reads
// back into exactly the database and documents of the main PC.
// Everything runs in a throwaway folder; nothing is sent anywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import knex from 'knex'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-safety-'))
process.env.SQLITE_PATH = path.join(dir, 'data.sqlite')
process.env.ADAL_BACKUP_STATE = path.join(dir, 'backup-state.json')
process.env.SECRETS_PATH = path.join(dir, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(dir, 'account-vault.key')
process.env.ADAL_BACKUP_SAFE = path.join(dir, 'SafeStorage')
process.env.ADAL_REPLICA_SNAPS = path.join(dir, 'snaps')
process.env.ADAL_REPLICA_LIST = path.join(dir, 'replicas.json')
process.env.SUPABASE_URL = ''
process.env.SUPABASE_ANON_KEY = ''

const B = await import('../src/services/telegramBackup.js')
const R = await import('../src/services/replica.js')
const { setSecret } = await import('../src/services/secretStore.js')
const PW = 'test-key-only-123'
setSecret('backup_password', PW)

const H = 3600e3, MIN = 60e3
const T0 = Date.parse('2026-11-19T08:00:00Z')

test('switched on in the morning, last backup 30 h old: one starts within a few minutes', () => {
  const lastFull = new Date(T0 - 30 * H).toISOString()
  const due = (afterBoot, robots = 0) => B.fullBackupDue({ now: T0 + afterBoot, bootAt: T0, lastFull, lastRun: lastFull, robots })
  assert.equal(due(30e3), false, 'not in the first seconds of starting')
  assert.equal(due(2 * MIN), true, 'quiet robots: at once after settling')
  assert.equal(due(2 * MIN, 1), false, 'a robot working: waits a little')
  assert.equal(due(5 * MIN, 1), true, 'but never more than 5 minutes')
})

test('during the day: every 2 hours, waiting for quiet robots at most 30 minutes; never at night only', () => {
  const boot = T0 - 5 * H
  const at = (sinceFull, robots = 0) => B.fullBackupDue({ now: T0, bootAt: boot, lastFull: new Date(T0 - sinceFull).toISOString(), lastRun: new Date(T0 - sinceFull).toISOString(), robots })
  assert.equal(at(1 * H), false)
  assert.equal(at(2 * H + MIN), true)
  assert.equal(at(2 * H + MIN, 2), false)
  assert.equal(at(2 * H + 31 * MIN, 2), true)
  // Two within 10 minutes never (a failed one is tried again by the retry).
  assert.equal(B.fullBackupDue({ now: T0, bootAt: boot, lastFull: new Date(T0 - 30 * H).toISOString(), lastRun: new Date(T0 - 2 * MIN).toISOString() }), false)
})

test('the newest good backup: this PC\'s whole backup, or a Companion\'s when newer', () => {
  fs.writeFileSync(process.env.ADAL_BACKUP_STATE, JSON.stringify({ last_full_ok: '2026-11-17T10:00:00.000Z', last_ok: '2026-11-18T10:00:00.000Z' }))
  assert.equal(B.backupHealth().last_good_at, '2026-11-17T10:00:00.000Z', 'a documents-only run is not a whole backup')
  B.recordCompanionBackup({ at: '2026-11-18T09:00:00.000Z', index_file_id: 'tg-1', by: 'Reception' })
  const h = B.backupHealth()
  assert.equal(h.last_good_at, '2026-11-18T09:00:00.000Z')
  assert.equal(h.companion_backup.by, 'Reception')
  // An older report changes nothing.
  B.recordCompanionBackup({ at: '2026-11-18T08:00:00.000Z' })
  assert.equal(B.backupHealth().companion_backup.at, '2026-11-18T09:00:00.000Z')
  // Old state files (no last_full_ok): the newest database set.
  assert.equal(B.lastFullAt({ sets: [{ type: 'dbz', date: '2026-11-10T00:00:00.000Z' }, { type: 'files', date: '2026-11-12T00:00:00.000Z' }] }), '2026-11-10T00:00:00.000Z')
})

test('a Companion\'s locked copy: chunks and documents restore into the very same data', async () => {
  // A database big enough for several chunks.
  const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.text('name') })
  for (let i = 0; i < 150; i++) await db('profiles').insert({ name: `girl ${i} `.repeat(2000) })
  await db.destroy()
  fs.mkdirSync(process.env.ADAL_BACKUP_SAFE, { recursive: true })
  const big = Buffer.alloc(R.PIECE + 1234, 7)
  fs.writeFileSync(path.join(process.env.ADAL_BACKUP_SAFE, 'passport.jpg'), Buffer.from('a passport'))
  fs.writeFileSync(path.join(process.env.ADAL_BACKUP_SAFE, 'big.pdf'), big)

  const m = await R.manifest()
  assert.ok(m.db.chunks.length >= 2, 'several chunks')
  assert.equal(m.docs.find(d => d.name === 'big.pdf').parts, 2)
  // Unchanged data: the same fingerprints (a Companion asks for nothing again).
  const again = await R.manifest()
  assert.deepEqual(again.db.chunks, m.db.chunks)

  // Every piece is locked: nothing readable leaves the main PC.
  const piece = R.dbChunk(m.snap, 0)
  assert.equal(piece.subarray(0, 7).toString(), 'ADALBK1')
  assert.throws(() => B.unlock(piece, 'wrong password'), /Wrong backup password/)

  // The Companion's index (what replica.go makes), with its pieces in memory.
  const store = new Map()
  const parts = m.db.chunks.map((_, i) => { store.set(`c${i}`, R.dbChunk(m.snap, i)); return `c${i}` })
  const sets = [{ type: 'rdb', date: m.made, length: m.db.length, chunk: m.db.chunk, z: m.db.z, parts }]
  for (const d of m.docs) {
    const ids = []
    for (let k = 0; k < d.parts; k++) { store.set(`${d.name}-${k}`, R.docPiece(d.name, k)); ids.push(`${d.name}-${k}`) }
    sets.push({ type: 'rfile', name: d.name, size: d.size, parts: ids })
  }
  const index = { adal_backup: 1, made: m.made, sets }
  const get = B.setReader(async (id) => store.get(id), PW)
  const raw = await B.databaseFromIndex(index, get)
  assert.ok(raw.equals(fs.readFileSync(path.join(process.env.ADAL_REPLICA_SNAPS, `${m.snap}.sqlite`))), 'the snapshot, byte for byte')
  assert.ok((await get(sets.find(s => s.name === 'big.pdf'))).equals(big), 'a document in two pieces')

  // verifyBackup reads it the same way (the index itself locked as always).
  store.set('idx', B.lock(zlib.gzipSync(Buffer.from(JSON.stringify(index))), PW))
  const v = await B.verifyBackup(null, { token: 't', password: PW, indexId: 'idx', profiles: 150, fetch: async (_t, id) => store.get(id), exists: async (_t, id) => store.has(id) })
  assert.equal(v.ok, true, v.why)
  assert.equal(v.profiles, 150)

  // A new main PC restores from a Companion over the office network (replica.go
  // serves /replica/index and /replica/piece/<name>, asked with the old number).
  const lanIndex = { ...index, sets: index.sets.map(s => ({ ...s, parts: s.parts.map(p => `rp:${p}`) })) }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    assert.equal(u.host, '192.168.1.20:47810')
    if (opts.headers?.['x-adal-number'] !== '47040') return { ok: false, status: 403 }
    const body = u.pathname === '/replica/index' ? B.lock(zlib.gzipSync(Buffer.from(JSON.stringify(lanIndex))), PW) : store.get(decodeURIComponent(u.pathname.replace('/replica/piece/', '')))
    return body ? { ok: true, status: 200, arrayBuffer: async () => body } : { ok: false, status: 404 }
  }
  try {
    await assert.rejects(B.restoreFromCompanion('http://192.168.1.20:47810', { number: '11111', password: PW }), /another main PC/)
    fs.rmSync(path.join(process.env.ADAL_BACKUP_SAFE, 'big.pdf'))
    const r = await B.restoreFromCompanion('http://192.168.1.20:47810', { number: '47040', password: PW })
    assert.equal(r.database, true)
    assert.ok(fs.readFileSync(`${process.env.SQLITE_PATH}.restored`).equals(raw), 'the database is put in place at the next start')
    assert.ok(fs.readFileSync(path.join(process.env.ADAL_BACKUP_SAFE, 'big.pdf')).equals(big), 'a missing document came back')
  } finally { globalThis.fetch = realFetch; fs.rmSync(`${process.env.SQLITE_PATH}.restored`, { force: true }) }

  // Path tricks get nothing.
  assert.throws(() => R.docPiece('../backup-state.json', 0), /No such document/)
  assert.throws(() => R.dbChunk('nope', 0), /snapshot is gone/)
})

test('the Companions holding a copy are listed with when they last took it', () => {
  R.recordReport({ id: 'pc1', name: 'Reception' }, '192.168.1.20', { made: '2026-11-19T07:00:00Z', synced_at: '2026-11-19T07:01:00Z', port: 47810, docs: 2 })
  const l = R.replicas()
  assert.equal(l[0].name, 'Reception')
  assert.equal(l[0].ip, '192.168.1.20')
  assert.equal(l[0].port, 47810)
})
