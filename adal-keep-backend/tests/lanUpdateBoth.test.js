// The main PC and a Companion update each other on the office network
// (2026-11-19: the main PC's internet timed out on the download while a
// Companion on the same Wi-Fi already had the newer release).
//
// Two (and more) local instances: this process is the main PC (installed
// layout, Supabase unreachable or failing), each Companion is its own process
// (tests/fixtures/lanPeer.mjs) holding a COMPLETE signed release. Releases are
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
process.env.ADAL_LAN_UPDATES = '0' // no UDP socket in tests
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
L.setAgencyNumbers(['470401'])
const TAG = L.agencyTag('470401')

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
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'adal-keep-backend', 'adal-keep-frontend'])
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

/** A PC holding a release (its own process). */
const kids = []
async function companion(name, rel, { pub = PUB, tamper = false } = {}) {
  const dir = path.join(T, name)
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  if (rel) {
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(rel.env))
    for (const [s, b] of Object.entries(rel.pieces)) fs.writeFileSync(path.join(dir, 'files', s), tamper && s === rel.env.manifest.sha256 ? Buffer.from('evil app') : b)
  }
  const kid = spawn(process.execPath, [path.join(HERE, 'fixtures', 'lanPeer.mjs'), dir, pub], { stdio: ['pipe', 'pipe', 'inherit'] })
  kids.push(kid)
  const lines = []
  let wake = () => {}
  kid.stdout.setEncoding('utf8')
  kid.stdout.on('data', (d) => { lines.push(...d.split('\n').filter(Boolean)); wake() })
  const next = (prefix) => new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`${name}: no ${prefix}`)), 30000)
    const look = () => { const i = lines.findIndex(l => prefix.some(p => l.startsWith(p))); if (i >= 0) { clearTimeout(t); ok(lines.splice(i, 1)[0]) } else wake = look }
    look()
  })
  const port = Number((await next(['PORT'])).split(' ')[1])
  return { dir, port, path: '/pc/update/lan', base: `http://127.0.0.1:${port}/pc/update/lan`, pull: async (base) => { kid.stdin.write(`pull ${base}\n`); return next(['PULLED', 'NOPE']) } }
}

// The main PC: an installed layout at release A, serving the same LAN routes.
fs.mkdirSync(path.join(ROOT, 'backend', 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'backend', 'server.js'), '// release a\n')
fs.mkdirSync(path.join(ROOT, 'adal-keep-frontend', 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'pages a')
fs.writeFileSync(path.join(ROOT, 'adal-companion.exe'), 'companion program a')
fs.writeFileSync(path.join(ROOT, '.adal-version.json'), JSON.stringify({ sha: R.A.env.manifest.sha, published_at: R.A.env.manifest.published_at, date: R.A.env.manifest.date, seq: 1, lock_hash: 'LOCK' }))
const mainApp = express()
mainApp.use(express.json())
const lanR = express.Router()
L.lanRoutes(lanR)
mainApp.use('/api/system', lanR)
mainApp.use('/api/system', S.default)
const mainSrv = await new Promise(ok => { const s = mainApp.listen(0, '127.0.0.1', () => ok(s)) })
const MAIN = `http://127.0.0.1:${mainSrv.address().port}`
const MAIN_LAN = `${MAIN}/api/system/update/lan`

const offer = (c, rel, tags = TAG) => fetch(`${MAIN_LAN}/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: rel.env.manifest.sha, published_at: rel.env.manifest.published_at, port: c.port, path: c.path, tags }) }).then(r => r.json())
const runs = () => fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8').trim()

after(() => {
  for (const k of kids) k.kill()
  mainSrv.close()
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.rmSync(T, { recursive: true, force: true })
})

test('main PC with Supabase unreachable updates from a Companion that holds the whole newer release', async () => {
  let told = 0
  L.startLan({ onNews: () => { told++ } })
  const c1 = await companion('companion-b', R.B)
  // The Companion pushes its offer; the main PC looks at its next minute.
  assert.deepEqual(await offer(c1, R.B), { ok: true, newer: true })
  assert.equal(told, 1)
  const check = await S.checkForUpdate()
  assert.equal(check.hasUpdate, true)
  assert.equal(check.source, 'lan')
  assert.equal(check.latest.sha, R.B.env.manifest.sha)
  const r = await S.applyNow()
  assert.equal(r.body?.success, true, JSON.stringify(r.body))
  assert.match(r.body.log, /Supabase not reachable/)
  assert.equal(runs(), '// release b')
  assert.equal(fs.readFileSync(path.join(ROOT, 'adal-keep-frontend', 'dist', 'index.html'), 'utf8'), 'pages b')
  assert.equal(fs.readFileSync(path.join(ROOT, 'adal-companion.exe'), 'utf8'), 'companion program b')
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.adal-version.json'), 'utf8')).sha, R.B.env.manifest.sha)
  // The main PC now keeps the COMPLETE release (manifest + every piece) to hand on.
  assert.equal(L.current()?.manifest.sha, R.B.env.manifest.sha)
  await L.completeRelease(L.current(), { tries: 1 })
  assert.equal(L.completeHere(R.B.env.manifest), true)
  const latest = await (await fetch(`${MAIN_LAN}/latest`)).json()
  assert.equal(latest.have.length, 3)
})

test('the reverse: a Companion on the older release takes the newer one from the main PC', async () => {
  const c2 = await companion('companion-a', R.A)
  assert.equal(await c2.pull(MAIN_LAN), `PULLED ${R.B.env.manifest.sha}`)
  const kept = JSON.parse(fs.readFileSync(path.join(c2.dir, 'current.json'), 'utf8'))
  assert.equal(kept.manifest.sha, R.B.env.manifest.sha)
  for (const s of Object.keys(R.B.pieces)) assert.ok(fs.existsSync(path.join(c2.dir, 'files', s)), 'every piece is kept')
  // Ranged piece from the main PC (a cut download goes on).
  const part = await fetch(`${MAIN_LAN}/file/${R.B.env.manifest.sha256}`, { headers: { Range: 'bytes=0-9' } })
  assert.equal(part.status, 206)
  assert.equal((await part.arrayBuffer()).byteLength, 10)
})

test('a release with a wrong signature is refused; so is a signed one whose piece was changed', async () => {
  const c3 = await companion('companion-c-other-key', R.C, { pub: OTHER_PUB })
  assert.equal((await offer(c3, R.C)).newer, true) // the offer itself is only news
  const r = await S.applyNow()
  assert.notEqual(r.body?.success, true)
  assert.equal(runs(), '// release b')
  // Signed by Adal, but the Companion's app piece is not the signed one.
  const c4 = await companion('companion-d-tampered', R.D, { tamper: true })
  await offer(c4, R.D)
  const r2 = await S.applyNow()
  assert.notEqual(r2.body?.success, true)
  assert.match(r2.body.log, /does not match/)
  assert.equal(runs(), '// release b')
  assert.equal(L.piecePath(R.D.env.manifest.sha256), null, 'nothing changed is kept')
})

test('an older release is refused (from a Companion and from Supabase)', async () => {
  const c5 = await companion('companion-a-old', R.A)
  assert.equal((await offer(c5, R.A)).newer, false)
  const peer = await L.newestFromPeers(R.B.env.manifest, { extra: false })
  assert.ok(!peer || peer.manifest.sha !== R.A.env.manifest.sha)
  // Supabase answering with the older release: "already up to date".
  const sup = await fakeSupabase(R.A)
  try {
    const r = await S.applyNow()
    assert.equal(runs(), '// release b')
    assert.ok(r.body?.alreadyUpToDate || !r.body?.success)
  } finally { sup.close(); process.env.SUPABASE_URL = 'http://127.0.0.1:1' }
})

test('another agency\'s offer is ignored', async () => {
  const c6 = await companion('companion-e-other-agency', R.E)
  assert.deepEqual(await offer(c6, R.E, L.agencyTag('999999')), { ok: true, newer: false })
  assert.deepEqual(await offer(c6, R.E, ''), { ok: true, newer: false })
  assert.equal(L.peers.has(c6.base), false)
  assert.equal(L.heard(`ADAL_KEEP_RELEASE_V1|${R.E.env.manifest.sha}|${R.E.env.manifest.published_at}|${c6.port}|${c6.path}|${L.agencyTag('999999')}`, '127.0.0.1'), false)
  const r = await S.applyNow()
  assert.notEqual(r.body?.success, true)
  assert.equal(runs(), '// release b')
})

/** A Supabase that answers latest.json with `rel` and fails every download (500). */
async function fakeSupabase(rel) {
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith('/release/latest.json')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(rel.env)) }
    res.statusCode = 500; res.end('busy')
  })
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok))
  process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`
  return srv
}

test('the Supabase download fails: a PC of the office with a newer release is tried at once', async () => {
  const c7 = await companion('companion-e', R.E)
  await offer(c7, R.E)
  const sup = await fakeSupabase(R.F) // newest on Supabase, but its download fails
  try {
    const r = await S.applyNow()
    assert.equal(r.body?.success, true, JSON.stringify(r.body))
    assert.match(r.body.log, /Download of fffffff failed/)
    assert.match(r.body.log, /Trying the office network at once: eeeeeee/)
    assert.equal(runs(), '// release e')
  } finally { sup.close(); process.env.SUPABASE_URL = 'http://127.0.0.1:1' }
})

test('a release copied by hand (scp) is installed from a .zip: signed and checked; unsigned refused', async () => {
  const dir = path.join(T, 'bundle-f')
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(R.F.env))
  for (const [s, b] of Object.entries(R.F.pieces)) fs.writeFileSync(path.join(dir, 'files', s), b)
  const zip = path.join(T, 'adal-release-f.zip')
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dir })
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
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'adal-keep-backend'])
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
