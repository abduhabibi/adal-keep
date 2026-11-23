// "Go back to previous version" and "What's new" (2026-11-22).
//
// The main PC (this process, installed layout) runs release X, which carries a
// signed way back to Y. An admin presses the button: the database is checked,
// Y comes from this PC's cache / the office / Supabase (here: Supabase), the
// main PC runs Y, and a Companion (its own process) takes the way back from
// the main PC over the network. Supabase still offering X changes nothing; the
// next release moves everyone forward. Signed with a throw-away key.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-rollback-'))
const ROOT = fs.mkdtempSync(path.join(BACK, '.test-rollback-main-'))
process.env.ADAL_LAN_RELEASE_DIR = path.join(T, 'main-release')
process.env.ADAL_WHATS_NEW_FILE = path.join(T, 'whats-new.json')
process.env.ADAL_PROJECT_ROOT = ROOT
process.env.SUPABASE_ANON_KEY = 'anon'
process.env.SUPABASE_URL = 'http://127.0.0.1:1'
process.env.ADAL_CHAT_SESSION_FILE = path.join(T, 'session.json')
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({ access_token: 'test-token', expires_at: Date.now() + 3600 * 1000 }))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB = path.join(T, 'pub.pem')
fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }))

const U = await import('../src/services/updateChannel.js')
U._setVerifyKeyForTests(fs.readFileSync(PUB, 'utf8'))
U._setDownloadDefaultsForTests({ backoff: 10, tries: 2 })
const L = await import('../src/services/lanRelease.js')
const RB = await import('../src/services/rollback.js')
const W = await import('../src/services/whatsNew.js')
const S = await import('../src/routes/systemUpdate.js')
const express = (await import('express')).default
const knex = (await import('knex')).default
L.setAgencyNumbers(['470401'])

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const sign = (m) => U.signManifest(m, privateKey)

/** A release's pieces and manifest (unsigned): the app, the Companion program, the online pages. */
function release(letter, hour, extra = {}) {
  const sha = letter.repeat(40)
  const stage = fs.mkdtempSync(path.join(T, 'stage-'))
  fs.mkdirSync(path.join(stage, 'adal-keep-backend'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'adal-keep-frontend', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'adal-keep-backend', 'server.js'), `// release ${letter}\n`)
  fs.writeFileSync(path.join(stage, 'adal-keep-frontend', 'dist', 'index.html'), `pages ${letter}`)
  const tgz = path.join(T, `${letter}.tar.gz`)
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', stage, 'adal-keep-backend', 'adal-keep-frontend'])
  const app = fs.readFileSync(tgz), prog = Buffer.from(`companion program ${letter}`), online = Buffer.from(`online pages ${letter}`)
  const at = new Date(Date.UTC(2026, 10, 20, hour)).toISOString()
  const manifest = {
    channel: 'release', sha, short: sha.slice(0, 7), message: `release ${letter}`, date: at, published_at: at, seq: Date.parse(at), everyone_at: at, early: [],
    file: `release/${sha}.tar.gz`, size: app.length, sha256: sha256(app), lock_hash: 'LOCK',
    programs: [{ name: 'adal-companion.exe', file: `programs/${sha256(prog)}-adal-companion.exe`, sha256: sha256(prog), size: prog.length }],
    online: { file: `online/${sha256(online)}.tar.gz`, sha256: sha256(online), size: online.length },
    changes: [], ...extra,
  }
  return { manifest, files: { [manifest.file]: app, [manifest.programs[0].file]: prog, [manifest.online.file]: online }, pieces: { [sha256(app)]: app, [sha256(prog)]: prog, [sha256(online)]: online } }
}

const Y = release('1', 8, { migrations: ['001_a.js'] })
const X = release('2', 10, { migrations: ['001_a.js', '002_b.js'], notes: ['Faster passport reading', 'A new Tasheer button', 'Fixes in the CV'] })
const back = RB.rollbackManifest(X.manifest, Y.manifest)
X.manifest.rollback = { manifest: back, signature: sign(back) }
const XE = { manifest: X.manifest, signature: sign(X.manifest) }
const Z = release('3', 12, { migrations: ['001_a.js', '002_b.js'], notes: ['Next one: three', 'bullets', 'here'] })
const ZE = { manifest: Z.manifest, signature: sign(Z.manifest) }

/** Supabase: latest.json is `latest`; every piece of Y, X and Z can be downloaded (Range works). */
let latest = XE
const cloudFiles = { ...Y.files, ...X.files, ...Z.files }
const sup = http.createServer((req, res) => {
  if (req.url.endsWith('/release/latest.json')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(latest)) }
  const key = Object.keys(cloudFiles).find(f => req.url.endsWith(`/adal-updates/${f}`))
  if (!key) { res.statusCode = 404; return res.end('no') }
  const buf = cloudFiles[key]
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
  if (!m) return res.end(buf)
  const start = Number(m[1]), end = Math.min(m[2] ? Number(m[2]) : buf.length - 1, buf.length - 1)
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 })
  res.end(buf.subarray(start, end + 1))
})
await new Promise(ok => sup.listen(0, '127.0.0.1', ok))
process.env.SUPABASE_URL = `http://127.0.0.1:${sup.address().port}`

// The main PC: installed at X (it keeps X's signed release, with the way back inside).
fs.mkdirSync(path.join(ROOT, 'backend', 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'backend', 'server.js'), '// release 2\n')
fs.mkdirSync(path.join(ROOT, 'adal-keep-frontend', 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'pages 2')
fs.writeFileSync(path.join(ROOT, 'adal-companion.exe'), 'companion program 2')
fs.writeFileSync(path.join(ROOT, '.adal-version.json'), JSON.stringify({ sha: X.manifest.sha, published_at: X.manifest.published_at, date: X.manifest.date, seq: X.manifest.seq, lock_hash: 'LOCK' }))
fs.mkdirSync(process.env.ADAL_LAN_RELEASE_DIR, { recursive: true })
fs.writeFileSync(path.join(process.env.ADAL_LAN_RELEASE_DIR, 'current.json'), JSON.stringify(XE))

const db = knex({ client: 'sqlite3', connection: { filename: path.join(T, 'db.sqlite') }, useNullAsDefault: true })
await db.schema.createTable('knex_migrations', t => { t.increments('id'); t.string('name'); t.integer('batch') })
await db('knex_migrations').insert([{ name: '001_a.js', batch: 1 }, { name: '002_b.js', batch: 2 }])

let role = 'owner'
const mainApp = express()
mainApp.locals.db = db
mainApp.use(express.json())
mainApp.use((req, res, next) => { if (role) req.auth = { role }; next() })
mainApp.use('/api/system', S.default)
const mainSrv = await new Promise(ok => { const s = mainApp.listen(0, '127.0.0.1', () => ok(s)) })
const API = `http://127.0.0.1:${mainSrv.address().port}/api/system`
const runs = () => fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8').trim()
const get = (p) => fetch(`${API}${p}`).then(async r => ({ status: r.status, body: await r.json() }))
const post = (p, b = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }))

after(async () => {
  mainSrv.close(); sup.close()
  await db.destroy()
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.rmSync(T, { recursive: true, force: true })
})

test('the way back: signed, one step, just after X; never a bare downgrade', () => {
  assert.equal(back.rollback_of, X.manifest.sha)
  assert.equal(back.sha, Y.manifest.sha)
  assert.equal(back.file, Y.manifest.file)
  assert.ok(back.seq > X.manifest.seq && back.seq < Z.manifest.seq)
  assert.equal(back.rollback, undefined)
  assert.deepEqual(back.migrations, ['001_a.js'])
  assert.equal(L.isNewer(back, X.manifest), true, 'the way back wins over X')
  assert.equal(L.isNewer(X.manifest, back), false, 'X is never taken again')
  assert.equal(L.isNewer(Z.manifest, back), true, 'the next release moves forward')
  assert.equal(L.isNewer(back, { sha: X.manifest.sha, date: X.manifest.date }), true, 'also against a PC that knows X only by its date')
  assert.equal(RB.rollbackOf(XE.manifest)?.manifest.sha, Y.manifest.sha)
  // Unsigned, or the way back of another release: not used.
  assert.equal(RB.rollbackOf({ ...XE.manifest, rollback: { manifest: back, signature: 'AAAA' } }), null)
  const other = { ...back, rollback_of: Z.manifest.sha }
  assert.equal(RB.rollbackOf({ ...XE.manifest, rollback: { manifest: other, signature: sign(other) } }), null)
  // Y itself, without the marker, is an older commit: refused.
  assert.equal(L.isNewer({ ...Y.manifest, seq: X.manifest.seq + 5 }, X.manifest), false)
})

test('What\'s new: at most 5 short bullets', () => {
  assert.deepEqual(W.cleanNotes(['- One ', '  two  words', '', '• three']), ['One', 'two words', 'three'])
  assert.throws(() => W.cleanNotes(['1', '2', '3', '4', '5', '6']), /at most 5/)
  assert.throws(() => W.cleanNotes(['x'.repeat(200)]), /under 160/)
})

test('the database is ahead of the version before: going back is refused, nothing changes', async () => {
  assert.deepEqual(await RB.migrationsAhead(db, ['001_a.js']), ['002_b.js'])
  assert.equal(await RB.migrationsAhead(db, null), null)
  const plan = await get('/update/rollback')
  assert.equal(plan.body.available, false)
  assert.match(plan.body.refused, /already changed this PC's database \(1 change: 002_b\.js\)/)
  const r = await post('/update/rollback')
  assert.equal(r.status, 409)
  assert.equal(r.body.databaseAhead, true)
  assert.equal(runs(), '// release 2')
})

test('only an admin can go back', async () => {
  await db('knex_migrations').where('name', '002_b.js').del() // (X's database change was never run here)
  role = 'employee'
  try { assert.equal((await post('/update/rollback')).status, 403) } finally { role = 'owner' }
  assert.equal(runs(), '// release 2')
})

test('an admin presses "Go back": the main PC runs Y, kept here, and says so once', async () => {
  const plan = await get('/update/rollback')
  assert.deepEqual([plan.body.available, plan.body.from, plan.body.to], [true, '2222222', '1111111'])
  const r = await post('/update/rollback')
  assert.equal(r.body.success, true, JSON.stringify(r.body))
  assert.match(r.body.message, /Went back to 1111111/)
  assert.equal(runs(), '// release 1')
  assert.equal(fs.readFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'utf8'), 'pages 1')
  assert.equal(fs.readFileSync(path.join(ROOT, 'adal-companion.exe'), 'utf8'), 'companion program 1')
  assert.equal(L.current().manifest.rollback_of, X.manifest.sha)
  // Once only: no second step back.
  assert.match((await get('/update/rollback')).body.reason, /already went back once/)
  // The card: once, until closed.
  const card = (await get('/update/whats-new')).body.whatsNew
  assert.equal(card.rollback, true)
  assert.match(card.notes[0], /went back to the version before/)
  await post('/update/whats-new/seen', { sha: card.sha })
  assert.equal((await get('/update/whats-new')).body.whatsNew, null)
})

test('Supabase still offering X changes nothing; the next release (with notes) moves forward and shows its What\'s new once', async () => {
  latest = XE
  const check = await S.checkForUpdate()
  assert.equal(check.hasUpdate, false)
  const r = await S.applyNow()
  assert.ok(r.body.alreadyUpToDate, JSON.stringify(r.body))
  assert.equal(runs(), '// release 1')
  latest = ZE
  const r2 = await S.applyNow()
  assert.equal(r2.body.success, true, JSON.stringify(r2.body))
  assert.equal(runs(), '// release 3')
  const card = (await get('/update/whats-new')).body.whatsNew
  assert.deepEqual(card.notes, Z.manifest.notes)
  assert.equal(card.rollback, false)
  await post('/update/whats-new/seen', { sha: Z.manifest.sha })
  assert.equal((await get('/update/whats-new')).body.whatsNew, null)
  assert.match((await get('/update/rollback')).body.reason, /no way back/)
})
