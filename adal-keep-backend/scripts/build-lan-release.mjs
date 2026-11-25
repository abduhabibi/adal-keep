#!/usr/bin/env node
/**
 * A release for ONE office, spread by its main PC over the LAN (the owner, 2026-11-25: "just update
 * the main first … the main thing is whether the Companions update themselves from the main").
 * This script only builds. It cannot upload: it never reads adal-admin/.env, uses no network call of
 * Node, and on Linux runs itself (and go, vite, wine) in a network namespace of its own, with no
 * network at all (--no-fence turns that off only where `unshare` is missing).
 *
 *   node adal-keep-backend/scripts/build-lan-release.mjs             dry run: builds, says every size; nothing signed
 *   … --sign                 signed with ~/.adal-keep/update-signing.pem (read in place), in --out
 *   --out DIR                default ~/.adal-keep/lan-releases/<short>
 *   --previous DIR           a signed release folder the patches start from (its current.json + files/);
 *                            also the main PC's own data/lan-release. Default: the newest one beside --out.
 *   --dist DIR / --online DIR   pages already built (default: built here) · --no-online · --no-programs
 *   --deps DIR               the USB's deps folder (backend-modules.zip, node-win-x64.zip): signs the packages and
 *                            Node too, so a Companion can take a whole first server, or new packages, from Main.
 *   --note "…"               What's new (3–5)      --key FILE   another key (tests)
 *
 * The folder: current.json { manifest, signature }, files/<sha256> (every piece), apply-release.ps1/.mjs,
 * README.txt. Copy it to the main PC, run apply-release.ps1 there (the same checks, the same way back as
 * every update). The Companions then take from Main only the files that differ.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { signManifest, verifyManifest } from '../src/services/updateChannel.js'
import { rollbackManifest } from '../src/services/rollback.js'
import { diff as bsdiff } from '../src/services/bsdiff.js'
import { cleanNotes } from '../src/services/whatsNew.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.join(HERE, '..'), ROOT = path.join(BACK, '..'), FRONT = path.join(ROOT, 'adal-keep-frontend')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : '' }

// ── No network: this process again, inside a network namespace with nothing in it ──
if (process.platform === 'linux' && !process.env.ADAL_LAN_BUILD_FENCED && !has('--no-fence')) {
  const uid = process.getuid(), gid = process.getgid()
  const probe = spawnSync('unshare', ['-rn', 'true'])
  if (probe.status !== 0) { console.error('This PC has no `unshare`: the build cannot be cut off the network (--no-fence to build anyway).'); process.exit(1) }
  const r = spawnSync('unshare', ['-rn', 'sh', '-c', `exec unshare -U --map-user=${uid} --map-group=${gid} "$@"`, 'sh', process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', env: { ...process.env, ADAL_LAN_BUILD_FENCED: '1' } })
  process.exit(r.status ?? 1)
}
globalThis.fetch = () => { throw new Error('this script has no network') }

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...o }).trim()
const SIGN = has('--sign')
const PRIV = SIGN ? fs.readFileSync(val('--key') || path.join(os.homedir(), '.adal-keep/update-signing.pem'), 'utf8') : null

const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no', '--', 'adal-keep-backend', 'adal-keep-frontend', 'adal-companion', 'adal-launcher'])
if (dirty) { console.error('Commit first — these are not committed:\n' + dirty); process.exit(1) }
const sha = sh('git', ['rev-parse', 'HEAD']), short = sha.slice(0, 7)
const COMMIT = Number(sh('git', ['log', '-1', '--pretty=%ct', sha]))
const OUT = path.resolve(val('--out') || path.join(os.homedir(), '.adal-keep/lan-releases', short))
const FILES = path.join(OUT, 'files')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(FILES, { recursive: true })
const put = (b) => { const h = sha256(b); fs.writeFileSync(path.join(FILES, h), b); return h }

// ── The release before: the patches start from it ──
const envIn = (d) => { try { const j = JSON.parse(fs.readFileSync(path.join(d, 'current.json'), 'utf8')); return j.signature && (verifyManifest(j.manifest, j.signature) || (val('--key') && j.manifest?.sha)) ? j : null } catch { return null } }
let PREV = val('--previous') ? path.resolve(val('--previous')) : ''
if (!PREV) {
  const around = path.dirname(OUT)
  PREV = (fs.existsSync(around) ? fs.readdirSync(around) : []).map(d => path.join(around, d)).filter(d => d !== OUT && envIn(d)).sort((a, b) => (envIn(b).manifest.seq || 0) - (envIn(a).manifest.seq || 0))[0] || ''
}
const prev = PREV ? envIn(PREV) : null
if (val('--previous') && !prev) { console.error(`No signed release in ${PREV}`); process.exit(1) }
const before = prev?.manifest || null
const old = (h) => { try { const b = fs.readFileSync(path.join(PREV, 'files', h)); return sha256(b) === h ? b : null } catch { return null } }
console.log(before ? `== patches from ${before.short}` : '== no release before here: whole pieces (the Companions still take only the files that differ)')

const patchOf = (from, to, file, extra = {}) => {
  if (!from || !to || from.length > 60 << 20) return null
  const pt = bsdiff(from, to)
  return pt.length < to.length * 0.5 ? { from: sha256(from), ...extra, file, sha256: put(pt), size: pt.length } : null
}
function packDir(cwd, names) {
  const f = path.join(os.tmpdir(), `adal-pack-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tar`)
  execFileSync('tar', ['-cf', f, '--sort=name', `--mtime=@${COMMIT}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-C', cwd, ...names])
  const raw = fs.readFileSync(f); fs.unlinkSync(f)
  return { raw, gz: zlib.gzipSync(raw, { level: 9 }) }
}
function oldRaw(p) {
  if (!p) return null
  const raw = p.raw && old(p.raw.sha256)
  if (raw) return raw
  const gz = old(p.sha256)
  return gz ? zlib.gunzipSync(gz) : null
}
function walk(d, base = d, out = {}) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, base, out); else if (e.isFile()) out[path.relative(base, f).split(path.sep).join('/')] = f }
  return out
}
const vite = (args, env = {}) => execFileSync(process.execPath, [path.join(FRONT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn', ...args], { cwd: FRONT, stdio: 'inherit', env: { ...process.env, ...env } })

function buildPrograms(dir, arch) {
  const out = path.join(dir, arch); fs.mkdirSync(out, { recursive: true })
  const env = { ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0', GOPROXY: 'off' }
  const go = (src, name, gui, pkg = '.') => {
    try { execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', `${gui ? '-H windowsgui ' : ''}-buildid=`, '-o', path.join(out, name), pkg], { cwd: path.join(ROOT, src), env, stdio: 'pipe' }) }
    catch (e) { if (arch === 'amd64') throw new Error(`${name}: ${String(e.stderr || e.message).trim()}`); console.log(`   (no 32-bit ${name})`) }
  }
  go('adal-launcher', 'AdalKeep.exe', true); go('adal-companion', 'adal-companion.exe', true); go('adal-agent', 'adal-agent.exe', false, './cmd/agent')
  const icon = path.join(dir, 'seticon.exe')
  if (!fs.existsSync(icon)) execFileSync('go', ['build', '-o', icon, '.'], { cwd: path.join(ROOT, 'adal-installer/tools/seticon'), env: { ...env, GOARCH: 'amd64' }, stdio: 'pipe' })
  const run = process.platform === 'win32' ? [icon] : ['wine', icon]
  for (const n of ['AdalKeep.exe', 'adal-companion.exe']) if (fs.existsSync(path.join(out, n))) execFileSync(run[0], [...run.slice(1), path.join(out, n), path.join(ROOT, 'adal.ico')], { stdio: 'pipe', env: { ...process.env, DISPLAY: '', WINEDEBUG: '-all', WINEPREFIX: path.join(dir, 'wine'), WINEDLLOVERRIDES: 'mscoree,mshtml=' } })
  const was = (arch === '386' ? before?.programs_x86 : before?.programs) || []
  return fs.readdirSync(out).map(name => {
    const b = fs.readFileSync(path.join(out, name)), h = put(b)
    const o = was.find(x => x.name === name)
    const patch = o && o.sha256 !== h ? patchOf(old(o.sha256), b, `programs/patches/${h.slice(0, 12)}-${name}.adalpatch`) : null
    return { name, sha256: h, size: b.length, file: `programs/${h}-${name}`, ...(patch ? { patch } : {}) }
  })
}

/** The packages and Node as the USB installs them: path → [sha256, size]. */
function packagesTree(dir, deps) {
  const lockNow = JSON.parse(fs.readFileSync(path.join(BACK, 'package-lock.json'), 'utf8'))
  const t = path.join(dir, 'deps'); fs.mkdirSync(t)
  execFileSync('unzip', ['-q', path.join(deps, 'backend-modules.zip'), '-d', t]); execFileSync('unzip', ['-q', path.join(deps, 'node-win-x64.zip'), '-d', t])
  const inst = JSON.parse(fs.readFileSync(path.join(t, 'node_modules/.package-lock.json'), 'utf8')).packages || {}
  const wrong = Object.entries(lockNow.packages).filter(([k, p]) => k && !p.dev && !p.optional && !p.devOptional && inst[k]?.version !== p.version).map(([k]) => k.replace('node_modules/', ''))
  if (wrong.length) { console.log(`   (the packages in --deps are not this version's: ${wrong.slice(0, 6).join(', ')}${wrong.length > 6 ? ` and ${wrong.length - 6} more` : ''} — not signed; run PREPARE again)`); return null }
  const files = {}
  for (const [rel, f] of Object.entries(walk(path.join(t, 'node_modules')))) { const b = fs.readFileSync(f); files[`backend/node_modules/${rel}`] = [sha256(b), b.length] }
  const node = fs.readdirSync(t).find(d => /^node-v/.test(d))
  const exe = fs.readFileSync(path.join(t, node, 'node.exe')); files['runtime/node.exe'] = [sha256(exe), exe.length]
  const b = zlib.gzipSync(Buffer.from(JSON.stringify({ files })), { level: 9 })
  return { file: `lan/${short}-tree.json.gz`, sha256: put(b), size: b.length, count: Object.keys(files).length }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lan-'))
try {
  // 1. The app: the committed backend files (never .env, data, uploads) and the pages.
  const stage = path.join(tmp, 'app')
  const list = sh('git', ['ls-files', '-z', '--', ...['src', 'scripts', 'robots', 'bin', 'server.js', 'main.js', 'safeStart.js', 'knexfile.js', 'package.json', 'package-lock.json', 'ocrb.traineddata'].map(x => `adal-keep-backend/${x}`)]).split('\0').filter(Boolean)
  for (const f of list) {
    if (/(^|\/)\.env|\.sqlite|\/data\/|\/uploads\//.test(f)) continue
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(stage, f))
  }
  const dist = path.join(stage, 'adal-keep-frontend/dist')
  if (val('--dist')) fs.cpSync(path.resolve(val('--dist')), dist, { recursive: true })
  else { console.log('== the pages'); vite(['--outDir', dist, '--emptyOutDir']) }
  const { raw, gz } = packDir(stage, ['adal-keep-backend', 'adal-keep-frontend'])
  const app_files = {}, at = walk(stage)
  for (const [rel, f] of Object.entries(at)) app_files[rel] = sha256(fs.readFileSync(f))

  // 2. Per file: a patch from the same file of the release before (a page's chunk by its name without the hash).
  const file_patches = {}
  let changed = 0, changedBytes = 0, patched = 0
  if (before?.app_files) {
    const oldTar = oldRaw({ sha256: before.sha256, raw: before.app_delta?.raw })
    const od = path.join(tmp, 'before'); fs.mkdirSync(od)
    if (oldTar) execFileSync('tar', ['-xf', '-', '-C', od], { input: oldTar, maxBuffer: 1 << 30 })
    const stem = (r) => r.replace(/-[\w-]{8}(\.\w+)$/, '$1')
    const byStem = new Map(Object.keys(before.app_files).map(r => [stem(r), r]))
    const known = new Set(Object.values(before.app_files))
    for (const [rel, h] of Object.entries(app_files)) {
      if (known.has(h)) continue
      changed++
      const b = fs.readFileSync(at[rel]); changedBytes += b.length
      const from = [rel, byStem.get(stem(rel))].map(r => r && path.join(od, r)).find(f => f && fs.existsSync(f))
      const p = from && b.length > 2048 ? patchOf(fs.readFileSync(from), b, `lan/${h.slice(0, 12)}.adalpatch`) : null
      if (p) { file_patches[h] = p; patched += p.size } else patched += b.length
    }
  }

  const programs = has('--no-programs') ? [] : (console.log('== the programs'), buildPrograms(path.join(tmp, 'prog'), 'amd64'))
  const programs_x86 = has('--no-programs') ? [] : buildPrograms(path.join(tmp, 'prog'), '386')
  let online = null
  if (!has('--no-online')) {
    let www = val('--online') ? path.resolve(val('--online')) : ''
    if (!www) { console.log('== the Companion\'s own pages'); www = path.join(tmp, 'www'); vite(['--mode', 'phone', '--outDir', www, '--emptyOutDir'], { VITE_PHONE: '1' }) }
    const o = packDir(www, ['.']), h = put(o.gz), rawSha = put(o.raw)
    online = { file: `online/${h}.tar.gz`, sha256: h, size: o.gz.length, raw: { sha256: rawSha, size: o.raw.length } }
    if (before?.online && before.online.sha256 !== h) { const p = patchOf(oldRaw(before.online), o.raw, `online/patches/${rawSha.slice(0, 12)}.adalpatch`, { from_gz: before.online.sha256 }); if (p) online.patch = p }
  }
  const tree = val('--deps') ? packagesTree(tmp, path.resolve(val('--deps'))) : null

  // 3. The manifest: the same as a published release's (every check, the way back, the probation), plus lan.
  const migrations = (rev) => { try { return sh('git', ['ls-tree', '--name-only', rev, 'adal-keep-backend/src/migrations/']).split('\n').filter(f => /\.(c|m)?js$/.test(f)).map(f => path.basename(f)) } catch { return null } }
  const now = new Date()
  const appSha = put(gz), appRaw = put(raw)
  const appPatch = before ? patchOf(oldRaw({ sha256: before.sha256, raw: before.app_delta?.raw }), raw, `release/patches/${appRaw.slice(0, 12)}.adalpatch`, { from_gz: before.sha256 }) : null
  const log = (r) => sh('git', ['log', '--pretty=%h%x09%cI%x09%s', '-n', '40', ...r]).split('\n').filter(Boolean).map(l => { const [s, date, ...m] = l.split('\t'); return { short: s, date, message: m.join('\t').slice(0, 300) } })
  let changes; try { changes = before ? log([`${before.sha}..${sha}`]) : log([sha]).slice(0, 1) } catch { changes = log([sha]).slice(0, 1) }
  const notes = cleanNotes(argv.flatMap((a, i) => a === '--note' && argv[i + 1] ? [argv[i + 1]] : []))
  const manifest = {
    channel: 'lan', lan: true, sha, short, message: sh('git', ['log', '-1', '--pretty=%s', sha]).slice(0, 300), date: sh('git', ['log', '-1', '--pretty=%cI', sha]),
    published_at: now.toISOString(), seq: Math.max(now.getTime(), (Number(before?.seq) || 0) + 1), everyone_at: now.toISOString(), early: [],
    file: `release/${sha}.tar.gz`, size: gz.length, sha256: appSha, app_delta: { raw: { sha256: appRaw, size: raw.length }, ...(appPatch ? { patch: appPatch } : {}) },
    app_files, file_patches, programs, programs_x86, ...(online ? { online } : {}), ...(tree ? { tree } : {}),
    lock_hash: sha256(fs.readFileSync(path.join(BACK, 'package-lock.json'))), changes, ...(notes.length ? { notes } : {}), migrations: migrations(sha),
  }
  if (before && before.sha !== sha && PRIV) {
    const m = before.migrations || migrations(before.sha)
    if (m) { const back = rollbackManifest(manifest, before, { migrations: m }); manifest.rollback = { manifest: back, signature: signManifest(back, PRIV) } }
  }
  const body = { manifest, ...(PRIV ? { signature: signManifest(manifest, PRIV) } : {}) }
  fs.writeFileSync(path.join(OUT, PRIV ? 'current.json' : 'UNSIGNED.json'), JSON.stringify(body))
  for (const f of ['apply-release.ps1', 'apply-release.mjs']) if (fs.existsSync(path.join(HERE, f))) fs.copyFileSync(path.join(HERE, f), path.join(OUT, f))
  fs.writeFileSync(path.join(OUT, 'README.txt'), `Adal Keep ${short}, for one office over its LAN. ${PRIV ? 'Signed by Adal.' : 'NOT SIGNED: a dry run, no PC takes it.'}\nCopy this folder to the main PC and run apply-release.ps1 there. Its Companions follow by themselves.\n`)
  console.log(`\n${short}: ${Object.keys(app_files).length} files, app ${kb(gz.length)}, programs ${kb(programs.reduce((n, p) => n + p.size, 0))}${online ? `, Companion pages ${kb(online.size)}` : ''}${tree ? `, packages list ${tree.count} files` : ', packages not signed (--deps)'}, manifest ${kb(JSON.stringify(body).length)}`)
  if (before) console.log(`since ${before.short}: ${changed} file(s) changed (${kb(changedBytes)}); a Companion takes ${kb(patched)} of them with the patches`)
  console.log(PRIV ? `signed → ${OUT}` : `dry run, nothing signed → ${OUT}`)
  console.log('Nothing was uploaded: this script has no network.')
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
