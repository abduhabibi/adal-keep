// A Companion's copy takes what changed (2026-11-25): frames of a database piece, documents since a list, no snapshot for signs of life.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-rdelta-'))
process.env.SQLITE_PATH = path.join(tmp, 'data.sqlite')
process.env.ADAL_BACKUP_SAFE = path.join(tmp, 'safe')
process.env.ADAL_REPLICA_SNAPS = path.join(tmp, 'snaps')
process.env.ADAL_REPLICA_LIST = path.join(tmp, 'replicas.json')
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'account-vault.key')
process.env.ADAL_BACKUP_STATE = path.join(tmp, 'backup-state.json')
fs.mkdirSync(process.env.ADAL_BACKUP_SAFE, { recursive: true })
const { default: knex } = await import('knex')
const D = await import('../src/services/replicaDelta.js')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('a piece of frames is read whole by any zstd reader; the changes make exactly the new piece', async () => {
  const a = crypto.randomBytes(200 * 1024), b = Buffer.from(a)
  b.write('changed', 50 * 1024)
  const fa = await D.framesOf(a), fb = await D.framesOf(b)
  assert.ok(zlib.zstdDecompressSync(D.joinFrames(fb)).equals(b))
  const sub = D.subPiece(fb, [3])
  assert.ok(sub.length < 18 * 1024)
  // As the Companion does it (adal-companion applySub; the Go test reads pieces made here).
  const hl = sub.readUInt32BE(8), h = JSON.parse(sub.subarray(12, 12 + hl))
  const frames = [...fa]; let at = 12 + hl
  for (const [i, n] of h.set) { frames[i] = sub.subarray(at, at + n); at += n }
  const whole = D.joinFrames(frames)
  assert.equal(crypto.createHash('sha256').update(whole).digest('hex'), h.sha256)
  assert.ok(whole.equals(D.joinFrames(fb)))
})

test('which frames differ is known for the last versions, over a restart too; an unknown one: whole', async () => {
  const f = path.join(tmp, 'v.gz'), v = new D.Versions({ file: f })
  const fp = (x) => { const b = Buffer.alloc(256 * 8, 1); if (x != null) b[x * 8] = 9; return b }
  v.add(0, 'a', fp()); v.add(0, 'b', fp(17))
  assert.deepEqual(v.changed(0, 'a', 'b', 4), [4])
  assert.deepEqual(v.changed(0, 'a', 'a', 4), [])
  assert.equal(v.changed(0, 'zz', 'b', 4), null)
  await v.save(0)
  assert.deepEqual(new D.Versions({ file: f }).changed(0, 'a', 'b', 4), [4])
  for (let i = 0; i < 20; i++) v.add(0, `n${i}`, fp(i))
  assert.equal(v.changed(0, 'a', 'n19', 4), null, 'an old one is forgotten')
})

test('documents: only what changed since the list a Companion has; the folder is listed once', async (t) => {
  const dir = path.join(tmp, 'docs'); fs.mkdirSync(dir)
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `p${i}.jpg`), `photo ${i}`)
  const feed = new D.DocsFeed(dir, (name, st) => ({ name, size: st.size, sum: `${st.size}|${st.mtimeMs}` }))
  t.after(() => feed.stop())
  feed.refresh()
  assert.equal(feed.all().length, 300)
  const at = feed.at
  assert.deepEqual(feed.since(at), { set: [], gone: [] })
  let listed = 0
  const real = fs.readdirSync; fs.readdirSync = (...a) => { if (a[0] === dir) listed++; return real(...a) }
  try {
    fs.writeFileSync(path.join(dir, 'p7.jpg'), 'another photo of hers'); fs.writeFileSync(path.join(dir, 'new.jpg'), 'n'); fs.rmSync(path.join(dir, 'p9.jpg'))
    await wait(300)
    feed.refresh()
    const c = feed.since(at)
    assert.deepEqual(c.set.map(x => x.name).sort(), ['new.jpg', 'p7.jpg']); assert.deepEqual(c.gone, ['p9.jpg'])
    for (let i = 0; i < 50; i++) feed.refresh()
    assert.equal(listed, 0, 'not listed again')
  } finally { fs.readdirSync = real }
  assert.equal(feed.since('other:3'), null, 'another start of the server: the whole list')
  assert.equal(feed.since(''), null)
})

test('the manifest: nothing changed is one line; signs of life make no new snapshot; a girl does', async (t) => {
  const db = knex({ client: 'sqlite3', connection: { filename: process.env.SQLITE_PATH }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  t.after(() => db.destroy())
  await db.raw('PRAGMA journal_mode = WAL')
  await db.schema.createTable('sync_log', x => { x.string('origin'); x.integer('seq'); x.string('tbl'); x.string('rid') })
  await db.schema.createTable('sync_dirty', x => { x.increments('seq'); x.string('tbl'); x.string('rid') })
  await db.schema.createTable('profiles', x => { x.increments('id'); x.string('full_name') })
  await db.batchInsert('profiles', [...Array(3000)].map((_, i) => ({ full_name: `girl ${i} ${'x'.repeat(400)}` })), 200)
  await db('sync_log').insert({ origin: 'm', seq: 1, tbl: 'profiles', rid: '1' })
  const { setSecret } = await import('../src/services/secretStore.js')
  setSecret('backup_password', 'test-key')
  const R = await import('../src/services/replica.js')
  t.after(() => R.docs.stop())
  fs.writeFileSync(path.join(process.env.ADAL_BACKUP_SAFE, 'passport.jpg'), 'p')
  const m1 = await R.manifestFor({ db })
  assert.ok(m1.db.chunks.length >= 1); assert.equal(m1.docs.length, 1)
  const m2 = await R.manifestFor({ db, have: m1.snap, docsAt: m1.docs_at })
  assert.ok(m2.same_db && m2.same_docs && !m2.db && !m2.docs)
  assert.ok(JSON.stringify(m2).length < 1200, `${JSON.stringify(m2).length} bytes`)
  // A PC's sign of life (45 s later): the same snapshot.
  const later = (ms) => { const now = Date.now; Date.now = () => now() + ms; return () => { Date.now = now } }
  await db('sync_log').insert({ origin: 'm', seq: 2, tbl: 'sync_pcs', rid: 'x' })
  let undo = later(60000)
  try { assert.equal((await R.manifestFor({ db, have: m1.snap, docsAt: m1.docs_at })).same_db, true) } finally { undo() }
  // A girl changed: a new snapshot, only the pieces that changed, and of them only the frames.
  await db('profiles').where({ id: 1500 }).update({ full_name: 'changed' })
  await db('sync_dirty').insert({ tbl: 'profiles', rid: '1500' })   // (not yet in the log)
  undo = later(60000)
  try {
    const m3 = await R.manifestFor({ db, have: m1.snap, docsAt: m1.docs_at })
    assert.ok(m3.snap !== m1.snap && m3.db.from === m1.snap)
    const [i, sum] = Object.entries(m3.db.set)[0]
    const whole = await R.dbChunkAsync(m3.snap, i, { framed: true })
    const part = await R.dbChunkAsync(m3.snap, i, { framed: true, base: m1.db.chunks[i] })
    const { unlock } = await import('../src/services/telegramBackup.js')
    assert.equal(unlock(part, 'test-key').subarray(0, 8).toString(), 'ADALSUB1')
    assert.ok(part.length < whole.length / 2 || part.length < 4000, `${part.length} of ${whole.length}`)
    // An unknown base: whole. The restore reads a piece of frames as any piece.
    const un = unlock(await R.dbChunkAsync(m3.snap, i, { framed: true, base: '0'.repeat(20) }), 'test-key')
    assert.equal(zlib.zstdDecompressSync(un).length, Math.min(R.CHUNK, m3.db.length - i * R.CHUNK))
  } finally { undo() }
  process.env.ADAL_REPLICA_DELTA = '0'
  try { assert.equal(D.deltaOn(), false) } finally { delete process.env.ADAL_REPLICA_DELTA }
})
