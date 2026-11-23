#!/usr/bin/env node
/**
 * Publishes the committed version to every agency PC (and the phone app to
 * every phone) through Supabase — the GitHub repository can be private.
 *
 *   node adal-keep-backend/scripts/publish-update.mjs [--skip-frontend] [--dry-run] [--now] [--skip-tests]
 *   node adal-keep-backend/scripts/publish-update.mjs --only-pcs PC1[,PC2]   (seed: only these PCs take it from Supabase)
 *   node adal-keep-backend/scripts/publish-update.mjs --open                 (lift the audience: every PC)
 *   node adal-keep-backend/scripts/publish-update.mjs --rollback      (everyone back to the version before)
 *
 * What's new (3–5 short plain-English bullets, shown once on each PC after it updates):
 *   --note "Passport photos crop by themselves" --note "…"     (or --notes-file notes.txt, one per line,
 *   or ADAL_WHATS_NEW="first|second|third" for the pre-push hook)
 *
 * Each release also carries a signed way back to the release before it
 * (manifest.rollback, services/rollback.js): an admin on an agency's main PC
 * presses "Go back to previous version" and the office follows, no key needed.
 *
 * The tests run first: when one fails, nothing is published (--skip-tests only
 * for an emergency). Staged: the agencies marked "updates first" in Adal Keep
 * Admin (adal-updates/release/early.json) get it at once, every other PC
 * STAGE_HOURS later (default 2) — unless --now (an urgent fix).
 *
 * 1. the frontend is built here (PCs no longer build it — no npm, no Vite)
 * 2. the backend's committed files + the built frontend → one .tar.gz
 * 3. a manifest (version, what changed, the archive's SHA-256, the package
 *    list's fingerprint) signed with ~/.adal-keep/update-signing.pem
 * 4. uploaded to Supabase Storage adal-updates/release/ with the service key
 *    from adal-admin/.env; the phone app goes to adal-updates/phone/
 * 5. older versions removed (the newest 3 stay)
 *
 * The working tree must be committed: a release is exactly one commit.
 *
 * Updates v2 (docs/updates-v2.md): every piece also gets a small patch from
 * the release before (bsdiff, services/bsdiff.js) — a typical release is then
 * well under 1 MB instead of ~60 MB; the whole pieces stay for every PC that
 * cannot use the patch. The programs are built for 64-bit AND 32-bit Windows.
 * Staged in three steps (services/rollout.js): the "updates first" agencies at
 * once, ~10% of agencies after ROLLOUT_HOLD_HOURS (default 1), everyone after
 * twice that. Before the upload, a release gate runs: 3 PCs of a fake agency on
 * this PC (scripts/release-gate.mjs; --skip-gate only in an emergency).
 *
 *   --rollout status|advance|stop|resume|everyone   (the release published now; also in Adal Keep Admin → Updates)
 *   --no-delta                                       (whole pieces only)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { signManifest, verifyManifest, BUCKET } from '../src/services/updateChannel.js'
import { rollbackManifest } from '../src/services/rollback.js'
import { cleanNotes } from '../src/services/whatsNew.js'
import zlib from 'zlib'
import { diff as bsdiff } from '../src/services/bsdiff.js'
import { newRollout, changeRollout, stageOf } from '../src/services/rollout.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..')
const ROOT = path.join(BACK, '..')
const FRONT = path.join(ROOT, 'adal-keep-frontend')
const argv = process.argv.slice(2)
const args = new Set(argv)
// What's new: every --note "…", or --notes-file, or ADAL_WHATS_NEW (| or new line between bullets).
const rawNotes = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--note' && argv[i + 1]) rawNotes.push(argv[++i])
  else if (argv[i].startsWith('--note=')) rawNotes.push(argv[i].slice(7))
  else if (argv[i] === '--notes-file' && argv[i + 1]) rawNotes.push(...fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/))
}
if (!rawNotes.length && process.env.ADAL_WHATS_NEW) rawNotes.push(...process.env.ADAL_WHATS_NEW.split(/\||\r?\n/))
const NOTES = cleanNotes(rawNotes)
if (NOTES.length && NOTES.length < 3) console.log(`   (What's new has ${NOTES.length} bullet(s); 3–5 read best)`)
// --only-pcs NAME,NAME: a signed audience — only these PCs (os.hostname()) take the release from Supabase;
// the others get it from them over the office network. --open then lifts it for everyone.
const ONLY = (() => {
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] === '--only-pcs' ? argv[i + 1] : argv[i].startsWith('--only-pcs=') ? argv[i].slice(11) : null
    if (v != null) return v.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  }
  return null
})()
if (ONLY && !ONLY.length) throw new Error('--only-pcs needs at least one PC name')
const DRY = args.has('--dry-run')
const HOLD_HOURS = Number(process.env.ROLLOUT_HOLD_HOURS || (process.env.STAGE_HOURS ? Number(process.env.STAGE_HOURS) / 2 : 1))
const ROLLOUT_PCT = Number(process.env.ROLLOUT_PCT || 10)
const DELTA = !args.has('--no-delta')
// The pieces of the last releases, kept on this PC: the next release's patches start from them (no download).
const CACHE = path.join(os.homedir(), '.adal-keep', 'release-cache')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const cacheGet = (h) => { try { const b = fs.readFileSync(path.join(CACHE, h)); return sha256(b) === h ? b : null } catch { return null } }
const cachePut = (b) => { try { fs.mkdirSync(CACHE, { recursive: true }); const h = sha256(b); const f = path.join(CACHE, h); if (!fs.existsSync(f)) fs.writeFileSync(f, b); return h } catch { return null } }
// Old cache files go after 21 days (a patch only ever starts from the release just before).
try { for (const f of fs.readdirSync(CACHE)) { const st = fs.statSync(path.join(CACHE, f)); if (Date.now() - st.mtimeMs > 21 * 86400000) fs.rmSync(path.join(CACHE, f), { force: true }) } } catch {}
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()

const admin = dotenv.parse(fs.readFileSync(path.join(ROOT, 'adal-admin/.env')))
const URL = admin.SUPABASE_URL, KEY = admin.SUPABASE_SERVICE_KEY
if (!URL || !KEY) throw new Error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
const PRIV = fs.readFileSync(path.join(os.homedir(), '.adal-keep/update-signing.pem'), 'utf8')
const storage = async (method, p, body, headers = {}) => {
  const r = await fetch(`${URL}/storage/v1/${p}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...headers }, body })
  if (!r.ok && !(method === 'GET' && r.status === 400)) throw new Error(`Supabase storage ${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r
}
const put = (p, buf, type) => storage('POST', `object/${BUCKET}/${p}`, buf, { 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'no-cache' })

/** The migration files a commit has (a PC refuses to go back to it when its database has others). Null: unknown. */
const migrationsAt = (rev) => {
  try { return sh('git', ['ls-tree', '--name-only', rev, 'adal-keep-backend/src/migrations/']).split('\n').filter(f => /\.(c|m)?js$/.test(f)).map(f => path.basename(f)) } catch { return null }
}

// The staged rollout of the release published now: status, or advance / stop / resume / everyone (signed again, same sha).
const ROLL = (() => { const i = argv.indexOf('--rollout'); return i >= 0 ? (argv[i + 1] || 'status') : (argv.find(a => a.startsWith('--rollout=')) || '').slice(10) || null })()
if (ROLL) {
  const cur = await (await storage('GET', `object/${BUCKET}/release/latest.json`)).json()
  if (!verifyManifest(cur.manifest, cur.signature)) throw new Error('latest.json is not signed')
  const show = (m) => console.log(`${m.short}: stage ${stageOf(m)}${m.rollout ? ` — test ${(m.rollout.test || []).length} agenc(ies), ${m.rollout.pct}% at ${m.rollout.pct_at}, everyone at ${m.rollout.everyone_at}` : ` — everyone at ${m.everyone_at}`}`)
  if (ROLL === 'status') { show(cur.manifest); process.exit(0) }
  const manifest = changeRollout(cur.manifest, ROLL)
  show(manifest)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }
  const body = Buffer.from(JSON.stringify({ manifest, signature: signManifest(manifest, PRIV) }))
  for (const f of [`release/${manifest.sha}.json`, 'release/latest.json']) await storage('POST', `object/${BUCKET}/${f}`, body, { 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-cache' })
  console.log('✓ the PCs follow at their next check')
  process.exit(0)
}

// The seeded release is opened to everyone: the same release, the audience lifted, signed again (a later seq).
if (args.has('--open')) {
  const cur = await (await storage('GET', `object/${BUCKET}/release/latest.json`)).json()
  if (!verifyManifest(cur.manifest, cur.signature)) throw new Error('latest.json is not signed')
  if (!cur.manifest.audience) { console.log(`${cur.manifest.short} is open to everyone already`); process.exit(0) }
  const now = new Date().toISOString()
  const { audience: _a, ...rest } = cur.manifest
  const manifest = { ...rest, published_at: now, seq: Math.max(Date.parse(now), (Number(cur.manifest.seq) || 0) + 1), everyone_at: now }
  console.log(`== ${manifest.short} (was only for ${cur.manifest.audience.pcs.join(', ')}) is opened to every PC`)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }
  const body = Buffer.from(JSON.stringify({ manifest, signature: signManifest(manifest, PRIV) }))
  await storage('POST', `object/${BUCKET}/release/${manifest.sha}.json`, body, { 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-cache' })
  await storage('POST', `object/${BUCKET}/release/latest.json`, body, { 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-cache' })
  console.log('✓ every PC takes it at its next check')
  process.exit(0)
}

// Everyone back to the version before the newest (it must still be in Storage).
if (args.has('--rollback')) {
  const cur = await (await storage('GET', `object/${BUCKET}/release/latest.json`)).json()
  if (!verifyManifest(cur.manifest, cur.signature)) throw new Error('latest.json is not signed')
  const list = await (await storage('POST', `object/list/${BUCKET}`, JSON.stringify({ prefix: 'release/', limit: 100, sortBy: { column: 'created_at', order: 'desc' } }), { 'Content-Type': 'application/json' })).json()
  const names = new Set(list.map(o => o.name))
  let back = null
  for (const o of list.filter(o => /^[0-9a-f]{40}\.json$/.test(o.name))) {
    const sha = o.name.slice(0, 40)
    if (sha === cur.manifest.sha || !names.has(`${sha}.tar.gz`)) continue
    const j = await (await storage('GET', `object/${BUCKET}/release/${o.name}`)).json()
    if (verifyManifest(j.manifest, j.signature)) { back = j.manifest; break }
  }
  if (!back) { console.error('No earlier version is kept in Storage to go back to.'); process.exit(1) }
  const now = new Date().toISOString()
  // One step only (its own way back dropped); the PCs check its database changes against theirs.
  const { rollback: _r, ...b } = back
  const manifest = { ...rollbackManifest({ ...cur.manifest, published_at: now, seq: Date.parse(now) - 1 }, b, { migrations: back.migrations || migrationsAt(back.sha) }), published_at: now, seq: Math.max(Date.parse(now), (Number(cur.manifest.seq) || 0) + 1), everyone_at: now }
  console.log(`== everyone goes back from ${cur.manifest.short} to ${back.short}`)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }
  await storage('POST', `object/${BUCKET}/release/latest.json`, Buffer.from(JSON.stringify({ manifest, signature: signManifest(manifest, PRIV) })), { 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'no-cache' })
  console.log('✓ every PC goes back within 15 minutes')
  process.exit(0)
}

const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no', '--', 'adal-keep-backend', 'adal-keep-frontend'])
if (dirty) { console.error('Commit first — these are not committed:\n' + dirty); process.exit(1) }
const sha = sh('git', ['rev-parse', 'HEAD'])
const COMMIT_TIME = Number(sh('git', ['log', '-1', '--pretty=%ct', sha])) || 0


// What is published now (for "what changed").
let previous = null
try {
  const r = await storage('GET', `object/${BUCKET}/release/latest.json`)
  if (r.ok) { const j = await r.json(); if (verifyManifest(j.manifest, j.signature)) previous = j.manifest }
} catch {}
if (previous?.sha === sha) { console.log(`Already published: ${sha.slice(0, 7)}`); process.exit(0) }

// 0. The tests: a version that fails one is never published.
if (!args.has('--skip-tests')) {
  console.log('== tests')
  try { execFileSync(process.execPath, ['scripts/run-tests.mjs', '--reporter=dot'], { cwd: BACK, stdio: 'inherit', timeout: 40 * 60 * 1000 }) }
  catch { console.error('✗ A test failed — nothing published. Fix it first (or --skip-tests in an emergency).'); process.exit(1) }
}

// 0b. The release gate: a fake agency with 3 PCs on this PC (create, edit, upload, one PC off and back, the update going round).
if (!args.has('--skip-gate') && !args.has('--skip-tests')) {
  console.log('== release gate (3 PCs of a fake agency on this PC)')
  let gate = null
  try { gate = await (await import('./release-gate.mjs')).releaseGate() } catch (e) { gate = { ok: false, error: e.message } }
  if (!gate?.ok) { console.error(`✗ The release gate failed${gate?.error ? `: ${gate.error}` : ''} — nothing published (--skip-gate in an emergency).`); process.exit(1) }
}

// 1. Frontend.
if (!args.has('--skip-frontend')) { console.log('== building the frontend'); execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'build'], { cwd: FRONT, stdio: 'inherit', shell: process.platform === 'win32' }) }

// 2. The bundle: committed backend files (never .env, data, uploads) + dist.
/**
 * Builds AdalKeep.exe, adal-companion.exe and adal-agent.exe with Go (the same
 * way as adal-installer/build-installer.sh, reproducibly: the same source
 * gives the same file) and uploads each new one once to programs/<sha256>.
 * No Go on this PC: the programs are left out and PCs keep theirs.
 */
async function buildPrograms(dir, arch = 'amd64') {
  const go = [process.env.GO, 'C:/AdalTools/go/bin/go.exe', 'go'].find(g => { try { return g && execFileSync(g, ['version'], { encoding: 'utf8' }) } catch { return false } })
  if (!go) { console.log('   (no Go here: the programs are not in this release)'); return [] }
  const out = path.join(dir, `programs-${arch}`); fs.mkdirSync(out, { recursive: true })
  const env = { ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0' }
  const build = (src, name, gui, pkg = '.') => {
    try { execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', `${gui ? '-H windowsgui ' : ''}-buildid=`, '-o', path.join(out, name), pkg], { cwd: path.join(ROOT, src), env, stdio: 'pipe' }) }
    catch (e) { if (arch === 'amd64') throw e; console.log(`   (no 32-bit ${name}: ${String(e.stderr || e.message).split('\n')[0].slice(0, 160)})`) }
  }
  build('adal-launcher', 'AdalKeep.exe', true)
  build('adal-companion', 'adal-companion.exe', true)
  build('adal-agent', 'adal-agent.exe', false, './cmd/agent')
  const seticon = path.join(os.tmpdir(), 'adal-seticon.exe')
  execFileSync(go, ['build', '-o', seticon, '.'], { cwd: path.join(ROOT, 'adal-installer/tools/seticon'), env, stdio: 'pipe' })
  // (A Windows-only tool: off Windows it runs under Wine, as build-installer.sh does.)
  const runIcon = (args) => process.platform === 'win32'
    ? execFileSync(seticon, args, { stdio: 'pipe' })
    : execFileSync('wine', [seticon, ...args], { stdio: 'pipe', env: { ...process.env, WINEDEBUG: '-all' } })
  for (const n of ['AdalKeep.exe', 'adal-companion.exe']) if (fs.existsSync(path.join(out, n))) runIcon([path.join(out, n), path.join(ROOT, 'adal.ico')])
  const list = []
  const before = arch === '386' ? previous?.programs_x86 : previous?.programs
  for (const name of fs.readdirSync(out)) {
    const buf = fs.readFileSync(path.join(out, name))
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const file = `programs/${sha256}-${name}`
    if (!DRY) {
      const have = await storage('GET', `object/info/${BUCKET}/${file}`).then(r => r.ok).catch(() => false)
      if (!have) await put(file, buf, 'application/octet-stream')
    }
    cachePut(buf)
    const p = { name, sha256, size: buf.length, file }
    // The patch from the same program of the release before.
    const old = (before || []).find(o => o.name === name && o.sha256 && o.sha256 !== sha256)
    if (old) { const pt = await makePatch(old, buf, `programs/patches/${sha256.slice(0, 12)}-from-${old.sha256.slice(0, 12)}-${name}.adalpatch`); if (pt) p.patch = pt }
    list.push(p)
  }
  fs.rmSync(out, { recursive: true, force: true })
  console.log(`   programs ${arch === '386' ? '32-bit' : '64-bit'}: ${list.map(p => `${p.name} ${p.sha256.slice(0, 8)}${p.patch ? ` (patch ${kb(p.patch.size)})` : ''}`).join(', ')}`)
  return list
}

const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/** A piece of the release before, by its SHA-256: this PC's cache, else Storage (then cached). */
async function oldPiece(p) {
  if (!p?.sha256) return null
  const hit = cacheGet(p.sha256)
  if (hit) return hit
  if (!p.file) return null
  try {
    const r = await storage('GET', `object/${BUCKET}/${p.file}`)
    if (!r.ok) return null
    const b = Buffer.from(await r.arrayBuffer())
    if (sha256(b) !== p.sha256) return null
    cachePut(b)
    return b
  } catch { return null }
}

/**
 * The patch old → nw (bsdiff), uploaded once: { from, from_gz?, file, sha256, size } or null
 * (no old piece here or in Storage, or a patch not much smaller than the whole piece).
 * old: a program ({ sha256, file }) or a .tar.gz piece with its plain .tar (`raw`).
 */
async function makePatch(old, nw, file, { gz = false } = {}) {
  if (!DELTA) return null
  let base = null
  if (gz) {
    base = old.raw?.sha256 ? cacheGet(old.raw.sha256) : null
    if (!base) { const g = await oldPiece(old); if (g) { try { base = zlib.gunzipSync(g); cachePut(base) } catch {} } }
  } else base = await oldPiece(old)
  if (!base) { console.log(`   (no patch for ${path.basename(file)}: the piece before is not here or in Storage)`); return null }
  const t = Date.now()
  const pt = bsdiff(base, nw)
  if (pt.length > nw.length * 0.5) { console.log(`   (no patch for ${path.basename(file)}: ${kb(pt.length)} is not much smaller)`); return null }
  const h = sha256(pt)
  if (!DRY) await put(file, pt, 'application/octet-stream')
  console.log(`   patch ${path.basename(file)}: ${kb(pt.length)} instead of ${kb(nw.length)} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  return { from: sha256(base), ...(gz ? { from_gz: old.sha256 } : {}), file, sha256: h, size: pt.length }
}

/** A folder as a plain .tar the same way each time (sorted, fixed times and owners), and its .tar.gz. */
function packDir(cwd, names, mtime) {
  const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar'
  const gnu = (() => { try { return /GNU tar/.test(execFileSync(tarBin, ['--version'], { encoding: 'utf8' })) } catch { return false } })()
  const archive = path.join(os.tmpdir(), `adal-pack-${process.pid}-${Date.now()}.tar`)
  execFileSync(tarBin, ['-cf', archive, ...(gnu ? ['--sort=name', `--mtime=@${mtime}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu'] : []), '-C', cwd, ...names])
  const raw = fs.readFileSync(archive)
  fs.unlinkSync(archive)
  return { raw, gz: zlib.gzipSync(raw, { level: 9 }) }
}

/**
 * The Adal Companion's own pages (the phone build, served on 127.0.0.1:47801
 * while the main PC cannot be reached): one .tar.gz, uploaded once to
 * online/<sha256>.tar.gz. Each Companion installs it itself (adal-companion
 * selfupdate.go) — from Supabase or from a PC of its office that has it.
 */
async function buildOnlinePages() {
  const www = path.join(ROOT, 'adal-phone/www')
  if (!args.has('--skip-frontend')) {
    try { execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'build:phone'], { cwd: FRONT, stdio: 'inherit', shell: process.platform === 'win32' }) }
    catch { console.log('   (the Companion pages could not be built: not in this release)'); return null }
  }
  if (!fs.existsSync(path.join(www, 'index.html'))) { console.log('   (no adal-phone/www: the Companion pages are not in this release)'); return null }
  const { raw, gz: buf } = packDir(www, ['.'], COMMIT_TIME)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const file = `online/${sha256}.tar.gz`
  if (!DRY) {
    const have = await storage('GET', `object/info/${BUCKET}/${file}`).then(r => r.ok).catch(() => false)
    if (!have) await put(file, buf, 'application/gzip')
  }
  cachePut(buf); const rawSha = cachePut(raw) || crypto.createHash('sha256').update(raw).digest('hex')
  console.log(`   Companion pages: ${(buf.length / 1048576).toFixed(1)} MB ${sha256.slice(0, 8)}`)
  const out = { file, sha256, size: buf.length, raw: { sha256: rawSha, size: raw.length } }
  const old = previous?.online
  if (old?.sha256 && old.sha256 !== sha256 && (old.raw?.sha256 || '') !== rawSha) {
    const pt = await makePatch(old, raw, `online/patches/${rawSha.slice(0, 12)}-from-${(old.raw?.sha256 || old.sha256).slice(0, 12)}.adalpatch`, { gz: true })
    if (pt) out.patch = pt
  }
  return out
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-release-'))
try {
  const files = sh('git', ['ls-files', '-z', '--', 'adal-keep-backend/src', 'adal-keep-backend/scripts', 'adal-keep-backend/server.js',
    'adal-keep-backend/main.js', 'adal-keep-backend/safeStart.js',
    'adal-keep-backend/knexfile.js', 'adal-keep-backend/package.json', 'adal-keep-backend/package-lock.json',
    // The passport-lines reader's model (src/services/quickMrz.js).
    'adal-keep-backend/ocrb.traineddata',
    // Small Windows helpers the server starts (bin/adal-clip.exe: double-C crop, services/screenClip.js).
    'adal-keep-backend/bin']).split('\0').filter(Boolean)
  for (const f of files) {
    if (/(^|\/)\.env|\.sqlite|\/data\/|\/uploads\//.test(f)) continue
    fs.mkdirSync(path.join(stage, path.dirname(f)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, f), path.join(stage, f))
  }
  fs.cpSync(path.join(FRONT, 'dist'), path.join(stage, 'adal-keep-frontend/dist'), { recursive: true })
  // Windows: its own tar (Git's tar reads C: as a remote host). The plain .tar is what patches rebuild exactly.
  const { raw: appRaw, gz: buf } = packDir(stage, ['adal-keep-backend', 'adal-keep-frontend'], COMMIT_TIME)
  const appRawSha = cachePut(appRaw) || sha256(appRaw)
  cachePut(buf)
  // Every file of the app by its SHA-256 (the self-check after an update compares the installed files with it).
  const appFiles = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else appFiles[path.relative(stage, f).split(path.sep).join('/')] = sha256(fs.readFileSync(f)) } }
  walk(stage)

  // 3. The signed manifest.
  const log = (range) => sh('git', ['log', '--pretty=%h%x09%cI%x09%s', '-n', '40', range]).split('\n').filter(Boolean)
    .map(l => { const [short, date, ...m] = l.split('\t'); return { short, date, message: m.join('\t').slice(0, 300) } })
  let changes
  try { changes = previous?.sha ? log(`${previous.sha}..${sha}`) : log(sha).slice(0, 1) } catch { changes = log(sha).slice(0, 1) }
  const manifest = {
    channel: 'release', sha, short: sha.slice(0, 7),
    message: sh('git', ['log', '-1', '--pretty=%s', sha]).slice(0, 300),
    date: sh('git', ['log', '-1', '--pretty=%cI', sha]),
    published_at: new Date().toISOString(),
    // The release order (never install an older one): publish time in ms, only ever goes up.
    seq: Math.max(Date.now(), (Number(previous?.seq) || Date.parse(previous?.published_at || '') || 0) + 1),
    file: `release/${sha}.tar.gz`, size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    // Updates v2: the app as a plain .tar and a small patch from the release before.
    app_delta: { raw: { sha256: appRawSha, size: appRaw.length }, ...(await (async () => {
      const old = previous?.sha256 ? { file: previous.file, sha256: previous.sha256, raw: previous.app_delta?.raw } : null
      const pt = old ? await makePatch(old, appRaw, `release/patches/${appRawSha.slice(0, 12)}-from-${(old.raw?.sha256 || old.sha256).slice(0, 12)}.adalpatch`, { gz: true }) : null
      return pt ? { patch: pt } : {}
    })()) },
    app_files: appFiles,
    // The Windows programs (AdalKeep.exe, the Companion, the agent): each PC
    // downloads only the ones that differ from its own (updates no longer need the USB).
    programs: await buildPrograms(stage),
    // The same for 32-bit Windows (GOARCH=386): a 32-bit PC uses these.
    programs_x86: await buildPrograms(stage, '386'),
    // The Adal Companion's own pages (each Companion installs them itself).
    online: await buildOnlinePages(),
    lock_hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, 'package-lock.json'))).digest('hex'),
    changes,
    // What's new (shown once on each PC after it updates) and this version's database changes.
    ...(NOTES.length ? { notes: NOTES } : {}),
    migrations: migrationsAt(sha),
    // Staged: these agencies at once, everyone else later.
    early: await (async () => { try { const r = await storage('GET', `object/${BUCKET}/release/early.json`); return r.ok ? ((await r.json()).agencies || []) : [] } catch { return [] } })(),
    ...(ONLY ? { audience: { pcs: ONLY } } : {}),
  }
  // Staged: the "updates first" agencies now, ~10% of agencies after the hold, everyone after twice the hold
  // (older PCs read early / everyone_at). --now (an urgent fix) or a seeded release: everyone at once.
  manifest.rollout = newRollout({ test: manifest.early, pct: ROLLOUT_PCT, holdHours: HOLD_HOURS, at: args.has('--now') || ONLY ? 'now' : null })
  manifest.everyone_at = manifest.rollout.everyone_at
  // The way back, signed now (only this PC has the key): the release before,
  // re-issued just after this one. Only when its app is still in Storage.
  if (previous?.sha && previous.sha !== sha) {
    const kept = DRY ? true : await storage('GET', `object/info/${BUCKET}/${previous.file || `release/${previous.sha}.tar.gz`}`).then(r => r.ok).catch(() => false)
    const migrations = previous.migrations || migrationsAt(previous.sha)
    if (kept && migrations) {
      const back = rollbackManifest(manifest, previous, { migrations })
      manifest.rollback = { manifest: back, signature: signManifest(back, PRIV) }
      console.log(`   way back: ${previous.short} (${migrations.length} database change(s) known to it)`)
    } else console.log(`   (no way back: ${kept ? 'the commit of ' + previous.short + ' is not in this checkout' : previous.short + ' is no longer in Storage'})`)
  }
  if (NOTES.length) console.log(`   What's new:\n${NOTES.map(n => `     • ${n}`).join('\n')}`)
  // What a PC downloads: the whole release, and with the patches (a PC on the release before).
  {
    const whole = buf.length + manifest.programs.reduce((n, p) => n + p.size, 0) + (manifest.online?.size || 0)
    const changedProgs = manifest.programs.filter(p => !(previous?.programs || []).some(o => o.sha256 === p.sha256))
    const small = (manifest.app_delta.patch?.size ?? buf.length) + changedProgs.reduce((n, p) => n + (p.patch?.size ?? p.size), 0) + (manifest.online && manifest.online.sha256 !== previous?.online?.sha256 ? (manifest.online.patch?.size ?? manifest.online.size) : 0)
    console.log(`   download per PC: ${kb(small)} with the patches (was ${kb(whole)} whole)`)
  }
  const signature = signManifest(manifest, PRIV)
  console.log(`== release ${manifest.short}: ${(buf.length / 1048576).toFixed(1)} MB, ${files.length} files, ${changes.length} change(s)`)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }

  // 4. Upload: the bundle first, then the note that points to it.
  await put(manifest.file, buf, 'application/gzip')
  // Each version's note is kept too (--rollback goes back to one).
  await put(`release/${sha}.json`, Buffer.from(JSON.stringify({ manifest, signature })), 'application/json')
  await put('release/latest.json', Buffer.from(JSON.stringify({ manifest, signature })), 'application/json')
  console.log(ONLY ? `✓ published for ${ONLY.join(', ')} only (the others get it from them over the office network; --open lifts it)` : args.has('--now') ? '✓ published for every agency PC' : `✓ published: ${manifest.early.length} agenc${manifest.early.length === 1 ? 'y' : 'ies'} marked "updates first" now, ${ROLLOUT_PCT}% of agencies at ${new Date(manifest.rollout.pct_at).toLocaleString()}, everyone at ${new Date(manifest.everyone_at).toLocaleString()} (Admin → Updates: advance / stop)`)

  // The phone app, when it is newer than the published one.
  const ver = JSON.parse(fs.readFileSync(path.join(BACK, 'src/phone-app/version.json'), 'utf8'))
  let pub = null
  try { const r = await storage('GET', `object/${BUCKET}/phone/version.json`); if (r.ok) pub = await r.json() } catch {}
  if (!pub || Number(pub.versionCode) < Number(ver.versionCode)) {
    await put('phone/AdalKeep.apk', fs.readFileSync(path.join(BACK, 'src/phone-app/AdalKeep.apk')), 'application/vnd.android.package-archive')
    await put('phone/version.json', Buffer.from(JSON.stringify(ver)), 'application/json')
    console.log(`✓ phone app ${ver.versionName} published`)
  }

  // 5. Only the newest 3 versions stay.
  const list = await (await storage('POST', `object/list/${BUCKET}`, JSON.stringify({ prefix: 'release/', limit: 100, sortBy: { column: 'created_at', order: 'desc' } }), { 'Content-Type': 'application/json' })).json()
  const keep = list.filter(o => o.name.endsWith('.tar.gz')).slice(0, 3).map(o => o.name.slice(0, 40))
  const old = list.filter(o => /^[0-9a-f]{40}\.(tar\.gz|json)$/.test(o.name) && !keep.includes(o.name.slice(0, 40))).map(o => `release/${o.name}`)
  if (old.length) { await storage('DELETE', `object/${BUCKET}`, JSON.stringify({ prefixes: old }), { 'Content-Type': 'application/json' }); console.log(`removed ${old.length} older version(s)`) }

  // 6. The website's download (adalkeep.pages.dev → /api/download → site/install-x64.ps1 in the private adal-install bucket):
  // refreshed with every release, no manual step. It re-uploads the installers on the USB folder (they update themselves to
  // this release on first start) and keeps the inner links valid 90 days. Never stops the release; skip: ADAL_NO_SITE=1.
  if (process.env.ADAL_NO_SITE !== '1' && fs.existsSync(path.join(ROOT, 'Adal Keep USB', '2 - Install Adal Main.exe'))) {
    try {
      console.log('== refreshing the website download')
      execFileSync(process.execPath, [path.join(ROOT, 'adal-keep-backend/scripts/publish-install.mjs'), '90'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ADAL_SITE_PUBLISH: '1' }, timeout: 25 * 60 * 1000 })
      console.log('✓ website download refreshed')
    } catch (e) { console.warn('!! website download not refreshed (the release is fine): run  ADAL_SITE_PUBLISH=1 node adal-keep-backend/scripts/publish-install.mjs 90') }
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
