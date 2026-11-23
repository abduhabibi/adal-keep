// Every PC updates only from Supabase (2026-11-23, the owner: no update pieces
// between the office's PCs). This process is the main PC (installed layout);
// a fake Supabase on this PC serves latest.json and the pieces. Releases are
// signed with a throw-away key made here: Adal's real key is never used.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lan2-'))
// The main PC's install sits inside the backend folder, so its packages load (brokenPackages).
const ROOT = fs.mkdtempSync(path.join(BACK, '.test-lan-main-'))
process.env.ADAL_LAN_RELEASE_DIR = path.join(T, 'main-release')
process.env.ADAL_PROJECT_ROOT = ROOT
process.env.SUPABASE_ANON_KEY = 'anon'
process.env.SUPABASE_URL = 'http://127.0.0.1:1' // unreachable
process.env.ADAL_CHAT_SESSION_FILE = path.join(T, 'session.json')
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({ access_token: 'test-token', expires_at: Date.now() + 3600 * 1000 }))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const other = crypto.generateKeyPairSync('ed25519')
const PUB = path.join(T, 'pub.pem'), OTHER_PUB = path.join(T, 'other.pem')
fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }))
fs.writeFileSync(OTHER_PUB, other.publicKey.export({ type: 'spki', format: 'pem' }))

const U = await import('../src/services/updateChannel.js')
U._setVerifyKeyForTests(fs.readFileSync(PUB, 'utf8'))
U._setDownloadDefaultsForTests({ backoff: 10, tries: 2 })
const L = await import('../src/services/lanRelease.js')
const S = await import('../src/routes/systemUpdate.js')
const express = (await import('express')).default

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const hex40 = (c) => c.repeat(40)

/** A signed release: the app (.tar.gz with backend + pages), one program, the online pages. */
function release(letter, seq, { key = privateKey } = {}) {
  const sha = hex40(letter)
  const stage = fs.mkdtempSync(path.join(T, 'stage-'))
  fs.mkdirSync(path.join(stage, 'adal-keep-backend'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'adal-keep-frontend', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'adal-keep-backend', 'server.js'), `// release ${letter}\n`)
  fs.writeFileSync(path.join(stage, 'adal-keep-backend', 'package.json'), '{"name":"x","type":"module"}')
  fs.writeFileSync(path.join(stage, 'adal-keep-frontend', 'dist', 'index.html'), `pages ${letter}`)
  const tgz = path.join(T, `${letter}.tar.gz`)
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', stage, 'adal-keep-backend', 'adal-keep-frontend'])
  const app = fs.readFileSync(tgz)
  const prog = Buffer.from(`companion program ${letter}`)
  const online = Buffer.from(`online pages ${letter}`)
  const at = new Date(Date.UTC(2026, 10, 19, 8 + seq)).toISOString()
  const manifest = {
    channel: 'release', sha, short: sha.slice(0, 7), message: `release ${letter}`,
    date: at, published_at: at, seq, everyone_at: at, early: [],
    file: `release/${sha}.tar.gz`, size: app.length, sha256: sha256(app), lock_hash: 'LOCK',
    programs: [{ name: 'adal-companion.exe', file: `programs/${sha256(prog)}-adal-companion.exe`, sha256: sha256(prog), size: prog.length }],
    online: { file: `online/${sha256(online)}.tar.gz`, sha256: sha256(online), size: online.length },
    changes: [],
  }
  const signature = crypto.sign(null, Buffer.from(U.canonical(manifest)), key).toString('base64')
  return { env: { manifest, signature }, pieces: { [sha256(app)]: app, [sha256(prog)]: prog, [sha256(online)]: online }, app, prog }
}

const R = { A: release('a', 1), B: release('b', 2), C: release('c', 3, { key: other.privateKey }), D: release('d', 4), E: release('e', 5), F: release('f', 6) }

// The main PC: an installed layout at release A.
fs.mkdirSync(path.join(ROOT, 'backend', 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'backend', 'server.js'), '// release a\n')
fs.mkdirSync(path.join(ROOT, 'adal-keep-frontend', 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'pages a')
fs.writeFileSync(path.join(ROOT, 'adal-companion.exe'), 'companion program a')
fs.writeFileSync(path.join(ROOT, '.adal-version.json'), JSON.stringify({ sha: R.A.env.manifest.sha, published_at: R.A.env.manifest.published_at, date: R.A.env.manifest.date, seq: 1, lock_hash: 'LOCK' }))
const mainApp = express()
mainApp.use(express.json())
mainApp.use('/api/system', S.default)
const mainSrv = await new Promise(ok => { const s = mainApp.listen(0, '127.0.0.1', () => ok(s)) })
const MAIN = `http://127.0.0.1:${mainSrv.address().port}`
const runs = () => fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8').trim()

after(() => {
  mainSrv.close()
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.rmSync(T, { recursive: true, force: true })
})

/**
 * A Supabase on this PC: latest.json is `rel`, its pieces are served by name (Range works).
 * fail: every piece answers 500; swap: a piece's bytes replaced by others.
 */
async function fakeSupabase(rel, { fail = false, swap = null } = {}) {
  const byFile = {}
  for (const p of [{ file: rel.env.manifest.file, sha256: rel.env.manifest.sha256 }, ...rel.env.manifest.programs, rel.env.manifest.online]) byFile[p.file] = rel.pieces[p.sha256]
  const asked = []
  const srv = http.createServer((req, res) => {
    asked.push(req.url)
    if (req.url.endsWith('/release/latest.json')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(rel.env)) }
    const name = decodeURIComponent(req.url.split('/adal-updates/')[1] || '').split('?')[0]
    let body = byFile[name]
    if (fail || !body) { res.statusCode = fail ? 500 : 404; return res.end('no') }
    if (swap && name === rel.env.manifest.file) body = swap
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    if (!m) return res.end(body)
    const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1)
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 })
    res.end(body.subarray(start, end + 1))
  })
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok))
  process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`
  return { asked, close: () => { srv.close(); process.env.SUPABASE_URL = 'http://127.0.0.1:1' } }
}

test('the main PC updates from Supabase: the app, a program, the pages, each checked', async () => {
  const sup = await fakeSupabase(R.B)
  try {
    const check = await S.checkForUpdate()
    assert.equal(check.hasUpdate, true)
    assert.equal(check.source, 'supabase')
    assert.equal(check.latest.sha, R.B.env.manifest.sha)
    const r = await S.applyNow()
    assert.equal(r.body?.success, true, JSON.stringify(r.body))
    assert.equal(r.body.source, 'supabase')
    assert.equal(runs(), '// release b')
    assert.equal(fs.readFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'utf8'), 'pages b')
    assert.equal(fs.readFileSync(path.join(ROOT, 'adal-companion.exe'), 'utf8'), 'companion program b')
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.adal-version.json'), 'utf8')).sha, R.B.env.manifest.sha)
    assert.equal(L.current()?.manifest.sha, R.B.env.manifest.sha, 'kept here (Go back, next patch)')
  } finally { sup.close() }
})

test('no PC hands updates to another: no LAN update routes, nothing in lanRelease talks to the network', async () => {
  for (const p of ['/api/system/update/lan/latest', `/api/system/update/lan/file/${R.B.env.manifest.sha256}`]) assert.equal((await fetch(`${MAIN}${p}`)).status, 404, p)
  assert.equal((await fetch(`${MAIN}/api/system/update/lan/offer`, { method: 'POST' })).status, 404)
  for (const gone of ['startLan', 'lanRoutes', 'newestFromPeers', 'offerToKnown', 'announce', 'heard', 'peers', 'completeRelease', 'pieceFromPeer']) assert.equal(L[gone], undefined, gone)
  const src = fs.readFileSync(path.join(BACK, 'src', 'services', 'lanRelease.js'), 'utf8')
  assert.doesNotMatch(src, /dgram|fetch\(/, 'no socket and no request of its own: only Supabase (updateChannel.js)')
})

test('a release with a wrong signature is refused; so is a signed one whose piece was changed', async () => {
  const sup = await fakeSupabase(R.C)   // signed with another key
  try {
    await assert.rejects(S.checkForUpdate())
    const r = await S.applyNow()
    assert.notEqual(r.body?.success, true)
    assert.equal(runs(), '// release b')
  } finally { sup.close() }
  const sup2 = await fakeSupabase(R.D, { swap: Buffer.from('evil app') })
  try {
    const r2 = await S.applyNow()
    assert.notEqual(r2.body?.success, true)
    assert.match(JSON.stringify(r2.body), /does not match/)
    assert.equal(runs(), '// release b')
    assert.equal(L.piecePath(R.D.env.manifest.sha256), null, 'nothing changed is kept')
  } finally { sup2.close() }
})

test('an older release on Supabase is refused ("already up to date")', async () => {
  const sup = await fakeSupabase(R.A)
  try {
    const r = await S.applyNow()
    assert.equal(runs(), '// release b')
    assert.ok(r.body?.alreadyUpToDate || !r.body?.success)
  } finally { sup.close() }
})

test('the Supabase download fails: nothing is installed and no other PC is asked', async () => {
  const sup = await fakeSupabase(R.E, { fail: true })
  try {
    const t0 = Date.now()
    const r = await S.applyNow()
    assert.notEqual(r.body?.success, true)
    assert.match(JSON.stringify(r.body), /Download of eeeeeee failed/)
    assert.doesNotMatch(JSON.stringify(r.body), /office network/)
    assert.equal(runs(), '// release b')
    assert.ok(Date.now() - t0 < 60000)
  } finally { sup.close() }
})

test('Supabase not reachable at all: the check fails at once, nothing waits on a peer', async () => {
  const t0 = Date.now()
  await assert.rejects(S.checkForUpdate(), /Supabase/)
  assert.ok(Date.now() - t0 < 15000, `${Date.now() - t0} ms`)
})

test('a release copied by hand (scp) is installed from a .zip: signed and checked; unsigned refused', async () => {
  const dir = path.join(T, 'bundle-f')
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(R.F.env))
  for (const [s, b] of Object.entries(R.F.pieces)) fs.writeFileSync(path.join(dir, 'files', s), b)
  const zip = path.join(T, 'adal-release-f.zip')
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '.'], { cwd: dir })   // no zip on Windows: its tar makes one
  else execFileSync('zip', ['-qr', zip, '.'], { cwd: dir })
  const r = await (await fetch(`${MAIN}/api/system/update/apply-local?path=${encodeURIComponent(zip)}`, { method: 'POST' })).json()
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(runs(), '// release f')
  // The same again: not newer.
  const again = await (await fetch(`${MAIN}/api/system/update/apply-local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: zip }) })).json()
  assert.equal(again.alreadyUpToDate, true)
  // Signed with another key: refused.
  const bad = path.join(T, 'bundle-bad')
  fs.mkdirSync(bad)
  fs.writeFileSync(path.join(bad, 'current.json'), JSON.stringify(R.C.env))
  for (const [s, b] of Object.entries(R.C.pieces)) fs.writeFileSync(path.join(bad, s), b)
  const no = await fetch(`${MAIN}/api/system/update/apply-local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bad }) })
  assert.equal(no.status, 500)
  assert.match((await no.json()).error, /no release signed by Adal/)
  assert.equal(runs(), '// release f')
})

test('apply-release.mjs (for a PC whose server is older than apply-local) runs the release\'s own code, which checks Adal\'s real key', () => {
  // A release whose app is this backend's real code; signed with the test key, so Adal's real key refuses it.
  const stage = fs.mkdtempSync(path.join(T, 'real-'))
  fs.mkdirSync(path.join(stage, 'adal-keep-backend'))
  for (const f of ['src', 'safeStart.js', 'package.json', 'server.js']) fs.cpSync(path.join(BACK, f), path.join(stage, 'adal-keep-backend', f), { recursive: true })
  const tgz = path.join(T, 'real.tar.gz')
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', stage, 'adal-keep-backend'])
  const app = fs.readFileSync(tgz)
  const manifest = { ...R.F.env.manifest, sha: hex40('9'), short: '9999999', sha256: sha256(app), size: app.length }
  const bundle = path.join(T, 'bundle-real')
  fs.mkdirSync(path.join(bundle, 'files'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'current.json'), JSON.stringify({ manifest, signature: crypto.sign(null, Buffer.from(U.canonical(manifest)), privateKey).toString('base64') }))
  fs.writeFileSync(path.join(bundle, 'files', sha256(app)), app)
  let out = ''
  try { out = execFileSync(process.execPath, [path.join(BACK, 'scripts', 'apply-release.mjs'), bundle, '--root', ROOT], { encoding: 'utf8', stdio: 'pipe' }) } catch (e) { out = `${e.stdout}${e.stderr}` }
  assert.match(out, /no release signed by Adal/)
  assert.equal(runs(), '// release f')
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'backend')).filter(n => n.startsWith('.apply-')), [], 'its work folder is removed')
})

test('a slow line: the download goes on where it was cut, retries, and checks the SHA-256', async () => {
  const data = crypto.randomBytes(1_200_000)
  let calls = 0
  const srv = http.createServer((req, res) => {
    calls++
    if (calls === 1) { res.statusCode = 503; return res.end() }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    const start = Number(m[1]), end = Math.min(Number(m[2]), data.length - 1)
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 })
    // Every answer is cut after 100 KB (the line drops).
    res.write(data.subarray(start, Math.min(end + 1, start + 100_000)))
    if (end + 1 - start > 100_000) setTimeout(() => res.destroy(), 20); else res.end()
  })
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}/x`
  const open = (s, e, signal) => fetch(url, { signal, headers: { Range: `bytes=${s}-${e}` } })
  try {
    const dest = path.join(T, 'slow.bin')
    await U.rangedDownload(open, dest, sha256(data), { chunk: 256 * 1024, tries: 3, backoff: 5 })
    assert.equal(sha256(fs.readFileSync(dest)), sha256(data))
    assert.ok(calls > 12, `in pieces (${calls} requests)`)
    // A wrong file is thrown away.
    calls = 1
    await assert.rejects(U.rangedDownload(open, path.join(T, 'wrong.bin'), '0'.repeat(64), { chunk: 512 * 1024, tries: 3, backoff: 5 }), /does not match/)
    assert.equal(fs.existsSync(path.join(T, 'wrong.bin.part')), false)
  } finally { srv.close() }
})
