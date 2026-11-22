#!/usr/bin/env node
/**
 * Publishes the committed version to every agency PC (and the phone app to
 * every phone) through Supabase — the GitHub repository can be private.
 *
 *   node adal-keep-backend/scripts/publish-update.mjs [--skip-frontend] [--dry-run] [--now] [--skip-tests]
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
const DRY = args.has('--dry-run')
const STAGE_HOURS = Number(process.env.STAGE_HOURS || 2)
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
  try { execFileSync(process.execPath, ['--test', '--test-reporter=dot', 'tests/**/*.test.js'], { cwd: BACK, stdio: 'inherit', timeout: 15 * 60 * 1000 }) }
  catch { console.error('✗ A test failed — nothing published. Fix it first (or --skip-tests in an emergency).'); process.exit(1) }
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
async function buildPrograms(dir) {
  const go = [process.env.GO, 'C:/AdalTools/go/bin/go.exe', 'go'].find(g => { try { return g && execFileSync(g, ['version'], { encoding: 'utf8' }) } catch { return false } })
  if (!go) { console.log('   (no Go here: the programs are not in this release)'); return [] }
  const out = path.join(dir, 'programs'); fs.mkdirSync(out, { recursive: true })
  const env = { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }
  const build = (src, name, gui, pkg = '.') => execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', `${gui ? '-H windowsgui ' : ''}-buildid=`, '-o', path.join(out, name), pkg], { cwd: path.join(ROOT, src), env, stdio: 'pipe' })
  build('adal-launcher', 'AdalKeep.exe', true)
  build('adal-companion', 'adal-companion.exe', true)
  build('adal-agent', 'adal-agent.exe', false, './cmd/agent')
  const seticon = path.join(os.tmpdir(), 'adal-seticon.exe')
  execFileSync(go, ['build', '-o', seticon, '.'], { cwd: path.join(ROOT, 'adal-installer/tools/seticon'), env, stdio: 'pipe' })
  // (A Windows-only tool: off Windows it runs under Wine, as build-installer.sh does.)
  const runIcon = (args) => process.platform === 'win32'
    ? execFileSync(seticon, args, { stdio: 'pipe' })
    : execFileSync('wine', [seticon, ...args], { stdio: 'pipe', env: { ...process.env, WINEDEBUG: '-all' } })
  for (const n of ['AdalKeep.exe', 'adal-companion.exe']) runIcon([path.join(out, n), path.join(ROOT, 'adal.ico')])
  const list = []
  for (const name of fs.readdirSync(out)) {
    const buf = fs.readFileSync(path.join(out, name))
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const file = `programs/${sha256}-${name}`
    if (!DRY) {
      const have = await storage('GET', `object/info/${BUCKET}/${file}`).then(r => r.ok).catch(() => false)
      if (!have) await put(file, buf, 'application/octet-stream')
    }
    list.push({ name, sha256, size: buf.length, file })
  }
  fs.rmSync(out, { recursive: true, force: true })
  console.log(`   programs: ${list.map(p => `${p.name} ${p.sha256.slice(0, 8)}`).join(', ')}`)
  return list
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
  const archive = path.join(os.tmpdir(), `adal-online-${Date.now()}.tar.gz`)
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-czf', archive, '-C', www, '.'])
  const buf = fs.readFileSync(archive)
  fs.unlinkSync(archive)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const file = `online/${sha256}.tar.gz`
  if (!DRY) {
    const have = await storage('GET', `object/info/${BUCKET}/${file}`).then(r => r.ok).catch(() => false)
    if (!have) await put(file, buf, 'application/gzip')
  }
  console.log(`   Companion pages: ${(buf.length / 1048576).toFixed(1)} MB ${sha256.slice(0, 8)}`)
  return { file, sha256, size: buf.length }
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
  const archive = path.join(os.tmpdir(), `adal-keep-${sha.slice(0, 7)}.tar.gz`)
  // Windows: its own tar (Git's tar reads C: as a remote host).
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-czf', archive, '-C', stage, 'adal-keep-backend', 'adal-keep-frontend'])
  const buf = fs.readFileSync(archive)
  fs.unlinkSync(archive)

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
    // The Windows programs (AdalKeep.exe, the Companion, the agent): each PC
    // downloads only the ones that differ from its own (updates no longer need the USB).
    programs: await buildPrograms(stage),
    // The Adal Companion's own pages (each Companion installs them itself).
    online: await buildOnlinePages(),
    lock_hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, 'package-lock.json'))).digest('hex'),
    changes,
    // What's new (shown once on each PC after it updates) and this version's database changes.
    ...(NOTES.length ? { notes: NOTES } : {}),
    migrations: migrationsAt(sha),
    // Staged: these agencies at once, everyone else later.
    early: await (async () => { try { const r = await storage('GET', `object/${BUCKET}/release/early.json`); return r.ok ? ((await r.json()).agencies || []) : [] } catch { return [] } })(),
    everyone_at: new Date(Date.now() + (args.has('--now') ? 0 : STAGE_HOURS * 3600 * 1000)).toISOString(),
  }
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
  const signature = signManifest(manifest, PRIV)
  console.log(`== release ${manifest.short}: ${(buf.length / 1048576).toFixed(1)} MB, ${files.length} files, ${changes.length} change(s)`)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }

  // 4. Upload: the bundle first, then the note that points to it.
  await put(manifest.file, buf, 'application/gzip')
  // Each version's note is kept too (--rollback goes back to one).
  await put(`release/${sha}.json`, Buffer.from(JSON.stringify({ manifest, signature })), 'application/json')
  await put('release/latest.json', Buffer.from(JSON.stringify({ manifest, signature })), 'application/json')
  console.log(args.has('--now') ? '✓ published for every agency PC' : `✓ published: ${manifest.early.length} agenc${manifest.early.length === 1 ? 'y' : 'ies'} marked "updates first" now, every other PC at ${new Date(manifest.everyone_at).toLocaleString()}`)

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
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
