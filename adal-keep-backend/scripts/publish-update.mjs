#!/usr/bin/env node
/**
 * Publishes the committed version to every agency PC (and the phone app to
 * every phone) through Supabase — the GitHub repository can be private.
 *
 *   node adal-keep-backend/scripts/publish-update.mjs [--skip-frontend] [--dry-run]
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..')
const ROOT = path.join(BACK, '..')
const FRONT = path.join(ROOT, 'adal-keep-frontend')
const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()

const admin = dotenv.parse(fs.readFileSync(path.join(ROOT, 'adal-admin/.env')))
const URL = admin.SUPABASE_URL, KEY = admin.SUPABASE_SERVICE_KEY
if (!URL || !KEY) throw new Error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
const PRIV = fs.readFileSync(path.join(os.homedir(), '.adal-keep/update-signing.pem'), 'utf8')

const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no', '--', 'adal-keep-backend', 'adal-keep-frontend'])
if (dirty) { console.error('Commit first — these are not committed:\n' + dirty); process.exit(1) }
const sha = sh('git', ['rev-parse', 'HEAD'])

const storage = async (method, p, body, headers = {}) => {
  const r = await fetch(`${URL}/storage/v1/${p}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...headers }, body })
  if (!r.ok && !(method === 'GET' && r.status === 400)) throw new Error(`Supabase storage ${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r
}
const put = (p, buf, type) => storage('POST', `object/${BUCKET}/${p}`, buf, { 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'no-cache' })

// What is published now (for "what changed").
let previous = null
try {
  const r = await storage('GET', `object/${BUCKET}/release/latest.json`)
  if (r.ok) { const j = await r.json(); if (verifyManifest(j.manifest, j.signature)) previous = j.manifest }
} catch {}
if (previous?.sha === sha) { console.log(`Already published: ${sha.slice(0, 7)}`); process.exit(0) }

// 1. Frontend.
if (!args.has('--skip-frontend')) { console.log('== building the frontend'); execFileSync('npm', ['run', '-s', 'build'], { cwd: FRONT, stdio: 'inherit' }) }

// 2. The bundle: committed backend files (never .env, data, uploads) + dist.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-release-'))
try {
  const files = sh('git', ['ls-files', '-z', '--', 'adal-keep-backend/src', 'adal-keep-backend/scripts', 'adal-keep-backend/server.js',
    'adal-keep-backend/knexfile.js', 'adal-keep-backend/package.json', 'adal-keep-backend/package-lock.json']).split('\0').filter(Boolean)
  for (const f of files) {
    if (/(^|\/)\.env|\.sqlite|\/data\/|\/uploads\//.test(f)) continue
    fs.mkdirSync(path.join(stage, path.dirname(f)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, f), path.join(stage, f))
  }
  fs.cpSync(path.join(FRONT, 'dist'), path.join(stage, 'adal-keep-frontend/dist'), { recursive: true })
  const archive = path.join(os.tmpdir(), `adal-keep-${sha.slice(0, 7)}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', stage, 'adal-keep-backend', 'adal-keep-frontend'])
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
    file: `release/${sha}.tar.gz`, size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    lock_hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, 'package-lock.json'))).digest('hex'),
    changes,
  }
  const signature = signManifest(manifest, PRIV)
  console.log(`== release ${manifest.short}: ${(buf.length / 1048576).toFixed(1)} MB, ${files.length} files, ${changes.length} change(s)`)
  if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0) }

  // 4. Upload: the bundle first, then the note that points to it.
  await put(manifest.file, buf, 'application/gzip')
  await put('release/latest.json', Buffer.from(JSON.stringify({ manifest, signature })), 'application/json')
  console.log('✓ published for every agency PC')

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
  const old = list.filter(o => o.name.endsWith('.tar.gz')).slice(3).map(o => `release/${o.name}`)
  if (old.length) { await storage('DELETE', `object/${BUCKET}`, JSON.stringify({ prefixes: old }), { 'Content-Type': 'application/json' }); console.log(`removed ${old.length} older version(s)`) }
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
