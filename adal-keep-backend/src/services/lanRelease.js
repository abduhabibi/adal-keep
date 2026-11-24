/**
 * lanRelease.js — the signed release kept on this PC (the name is from when the
 * office's PCs handed releases to each other; that was removed on 2026-11-23,
 * the owner: every PC updates only from Supabase).
 *
 *   data/lan-release/current.json      the signed manifest this PC runs
 *   data/lan-release/files/<sha256>    its pieces (and the release before's):
 *                                      "Go back to previous version" needs no
 *                                      internet, and the next release's small
 *                                      patches (updates v2) start from them.
 *
 * fetchPiece: kept here, else rebuilt from a patch, else from Supabase.
 * importRelease: a signed release copied by hand (USB / scp).
 * agencyTag: the agency's tag the office's PCs use to recognise each other (sync/peers.js).
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import zlib from 'zlib'
import { verifyManifest, downloadRelease, rangedDownload, sha256File } from './updateChannel.js'
import { patch as applyPatch } from './bsdiff.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const DIR = process.env.ADAL_LAN_RELEASE_DIR || path.join(DATA, 'lan-release')
const FILES = path.join(DIR, 'files')
const CURRENT = path.join(DIR, 'current.json')
const HEX = /^[0-9a-f]{64}$/

export function current() {
  try {
    const env = JSON.parse(fs.readFileSync(CURRENT, 'utf8'))
    return env?.manifest && verifyManifest(env.manifest, env.signature) ? { manifest: env.manifest, signature: env.signature } : null
  } catch { return null }
}

/**
 * The pieces of a manifest, by SHA-256: the app, the programs, the Companion's pages.
 * Since updates v2 (docs/updates-v2.md) a piece may also name its plain .tar (`raw`) and a
 * small patch from the release before (`patch`): any form of it counts, every form is handed on.
 * `all`: the 32-bit programs too (handed on when here, never fetched just to hand on).
 */
const form = (f) => (f && HEX.test(f.sha256 || '') ? f : undefined)
export function piecesOf(m, { all = false } = {}) {
  const out = []
  const delta = (p) => ({ ...(form(p?.raw) ? { raw: p.raw } : {}), ...(form(p?.patch) && p.patch.file ? { patch: p.patch } : {}),
    ...(Array.isArray(p?.patches) && p.patches.some(x => form(x) && x.file) ? { patches: p.patches.filter(x => form(x) && x.file) } : {}) })
  if (m?.sha256 && m.file) out.push({ file: m.file, sha256: m.sha256, size: m.size, ...delta(m.app_delta) })
  for (const p of m?.programs || []) if (p?.sha256) out.push({ file: p.file, sha256: p.sha256, name: p.name, size: p.size, ...delta(p) })
  if (all) for (const p of m?.programs_x86 || []) if (p?.sha256) out.push({ file: p.file, sha256: p.sha256, name: p.name, size: p.size, arch: 'x86', ...delta(p) })
  if (m?.online?.sha256) out.push({ file: m.online.file, sha256: m.online.sha256, size: m.online.size, ...delta(m.online) })
  return out
}
/** Every SHA-256 a piece can be kept as: itself, its plain .tar, its patch. */
export const formsOf = (p) => [p?.sha256, p?.raw?.sha256, p?.patch?.sha256].filter(s => HEX.test(s || ''))
/** The kept form of a piece (the piece itself or its plain .tar), or null. */
export const pieceHere = (p) => piecePath(p?.sha256) || piecePath(p?.raw?.sha256)

/** A piece kept here to hand on (only one the signed manifest names, checked). */
export async function keepPiece(sha256, from) {
  if (!HEX.test(sha256) || !fs.existsSync(from)) return false
  if ((await sha256File(from)) !== sha256) return false
  fs.mkdirSync(FILES, { recursive: true })
  const dest = path.join(FILES, sha256)
  if (path.resolve(from) !== path.resolve(dest)) fs.copyFileSync(from, dest)
  return true
}
export const piecePath = (sha256) => HEX.test(sha256) && fs.existsSync(path.join(FILES, sha256)) ? path.join(FILES, sha256) : null
/** The pieces of the kept release that are here. */
export const haveOf = (m) => piecesOf(m, { all: true }).flatMap(formsOf).filter(s => piecePath(s))
export const completeHere = (m) => !!m && piecesOf(m).every(p => pieceHere(p))

/**
 * The release now installed here: kept (signed), its pieces that are here kept
 * too (the programs as installed), the rest of the cache dropped.
 */
export async function recordInstalled(env, projectRoot = '') {
  if (!env?.manifest || !verifyManifest(env.manifest, env.signature)) return false
  fs.mkdirSync(FILES, { recursive: true })
  fs.writeFileSync(CURRENT, JSON.stringify({ manifest: env.manifest, signature: env.signature }))
  for (const p of env.manifest.programs || []) {
    if (projectRoot && p.name && !piecePath(p.sha256)) await keepPiece(p.sha256, path.join(projectRoot, p.name)).catch(() => {})
  }
  // The pieces of the release before stay too: "Go back to previous version" then needs no internet (services/rollback.js).
  // (Every form: the next release's patches start from this one's plain .tar.)
  const wanted = new Set([...piecesOf(env.manifest, { all: true }), ...piecesOf(env.manifest.rollback?.manifest, { all: true })].flatMap(formsOf))
  for (const f of fs.readdirSync(FILES)) {
    const base = f.replace(/\.part$/, '')
    // A half-download of a piece still wanted (or of a newer release, for a day) stays: the next try goes on from it.
    if (wanted.has(base)) continue
    if (f.endsWith('.part')) { try { if (Date.now() - fs.statSync(path.join(FILES, f)).mtimeMs < 24 * 3600 * 1000) continue } catch {} }
    fs.rmSync(path.join(FILES, f), { force: true })
  }
  return true
}

const ms = (v) => { const n = Date.parse(String(v || '')); return Number.isFinite(n) ? n : 0 }
const sameSha = (a, b) => { const n = Math.min(String(a).length, String(b).length); return n >= 7 && String(a).slice(0, n) === String(b).slice(0, n) }

/**
 * True only when m is a LATER release than `than` (asked on 2026-11-19: "it
 * is just downgrading"). The order: the signed manifest's publish sequence /
 * publish time; the commit date (manifest.date) is the fallback, and an older
 * commit is never taken unless Adal rolled back on purpose (rollback_of).
 * Another sha alone is never "newer". When the order cannot be told: not newer.
 */
export function isNewer(m, than) {
  if (!m?.sha) return false
  if (!than?.sha) return true
  if (sameSha(m.sha, than.sha)) return false
  // Adal's signed way back from exactly the release this PC runs ("Go back to previous version", services/rollback.js).
  if (m.rollback_of && sameSha(m.rollback_of, than.sha)) return true
  const mc = ms(m.date), tc = ms(than.date)
  if (mc && tc && mc < tc && !m.rollback_of) return false
  const mq = Number(m.seq) || 0, tq = Number(than.seq) || 0
  if (mq && tq) return mq > tq
  const mp = ms(m.published_at), tp = ms(than.published_at)
  if (mp && tp) return mp > tp
  if (mc && tc) return mc > tc
  if (mp && tc) return mp > tc // published after the commit this PC runs
  return false
}

/** Whether the order of `than` is known at all (else only Supabase is trusted). */
export const orderKnown = (than) => !!(than?.sha && (ms(than.published_at) || ms(than.date) || Number(than.seq)))

/** Updates v2 patches on (ADAL_DELTA=0: always the whole piece, as before). */
export const deltaOn = () => process.env.ADAL_DELTA !== '0'

/**
 * The file a patch starts from: kept here (the plain .tar of the release
 * before, or its .tar.gz un-gzipped), else a program installed on this PC
 * (`local`: paths). Only one whose SHA-256 is the patch's `from`.
 */
export async function patchBase(pt, local = []) {
  const want = pt?.from
  if (!HEX.test(want || '')) return null
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  const kept = piecePath(want)
  if (kept) { const b = fs.readFileSync(kept); if (sha(b) === want) return b }
  if (HEX.test(pt.from_gz || '') && piecePath(pt.from_gz)) {
    try { const b = zlib.gunzipSync(fs.readFileSync(piecePath(pt.from_gz))); if (sha(b) === want) return b } catch {}
  }
  for (const f of local) {
    try { if (f && fs.existsSync(f) && (await sha256File(f)) === want) return fs.readFileSync(f) } catch {}
  }
  return null
}

/**
 * The piece rebuilt from the release before + its small patch (from
 * Supabase): its plain .tar (or the program itself) lands in the
 * cache, checked against the signed SHA-256. Null when there is no base here.
 */
async function viaPatch(manifest, piece, { cloud = true, local = [] } = {}) {
  // The patch from whichever earlier release is here (the one just before first).
  let pt = null, base = null
  for (const c of [piece.patch, ...(piece.patches || [])].filter(Boolean)) {
    base = await patchBase(c, local)
    if (base) { pt = c; break }
  }
  if (!base) return null
  const target = piece.raw?.sha256 || piece.sha256
  const pfile = path.join(FILES, pt.sha256)
  if (!piecePath(pt.sha256)) {
    if (!cloud) throw new Error('the patch is not here')
    await downloadRelease({ file: pt.file, sha256: pt.sha256, size: pt.size }, pfile)
  }
  const out = applyPatch(base, fs.readFileSync(pfile))
  if (crypto.createHash('sha256').update(out).digest('hex') !== target) throw new Error('the patched file does not match Adal\'s signed release')
  const dest = path.join(FILES, target)
  fs.writeFileSync(`${dest}.tmp`, out)
  fs.renameSync(`${dest}.tmp`, dest)
  return { file: dest, bytes: pt.size || fs.statSync(pfile).size }
}

/**
 * A piece of a signed release: kept here already (any form), else rebuilt
 * from the release before and a small patch, else from Supabase (resumable,
 * unless cloud is false). It lands in this PC's cache and is copied to `dest` when one is given — the
 * .tar.gz or the plain .tar (tar -xf reads both). Checked every time.
 * `local`: files on this PC a program patch may start from (the installed program).
 */
/**
 * Half-downloads of pieces no release wants any more (2026-11-24: Main kept two from the day
 * before): gone. A .part of a piece of `manifest` (or of the kept release) always stays — the next
 * try goes on from it. Returns the names removed.
 */
export function cleanParts(manifest, { maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  const keep = new Set([...piecesOf(manifest, { all: true }), ...piecesOf(current()?.manifest, { all: true })].flatMap(p => [...formsOf(p), ...(p.patches || []).map(x => x.sha256)]))
  const gone = []
  try {
    for (const f of fs.readdirSync(FILES)) {
      if (!f.endsWith('.part') || keep.has(f.slice(0, -5))) continue
      const fp = path.join(FILES, f)
      try { if (now - fs.statSync(fp).mtimeMs < maxAgeMs) continue; fs.rmSync(fp, { force: true }); gone.push(f) } catch {}
    }
  } catch {}
  if (gone.length) console.log(`[update] old half-downloads removed: ${gone.length}`)
  return gone
}

export async function fetchPiece(manifest, piece, dest, { cloud = true, local = [] } = {}) {
  if (!HEX.test(piece?.sha256 || '')) throw new Error('bad piece')
  fs.mkdirSync(FILES, { recursive: true })
  cleanParts(manifest)
  // The full description from the signed manifest (callers may pass only file + sha256).
  piece = { ...(piecesOf(manifest, { all: true }).find(p => p.sha256 === piece.sha256) || {}), ...piece }
  const out = (from) => { if (dest && path.resolve(dest) !== path.resolve(from)) fs.copyFileSync(from, dest); return dest || from }
  for (const s of [piece.sha256, piece.raw?.sha256]) {
    const hit = piecePath(s)
    if (hit && (await sha256File(hit)) === s) return out(hit)
  }
  const label = path.basename(piece.file || piece.sha256)
  if ((piece.patch || piece.patches?.length) && deltaOn()) {
    try {
      const r = await viaPatch(manifest, piece, { cloud, local })
      if (r) { console.log(`[lan-update] ${label} rebuilt from the version before + a ${(r.bytes / 1024).toFixed(0)} KB patch`); return out(r.file) }
    } catch (e) { console.warn(`[lan-update] ${label}: the patch did not work (${e.message}) — the whole piece instead`) }
  }
  if (!cloud) throw new Error(`${label} is not kept on this PC`)
  const cache = path.join(FILES, piece.sha256)
  await downloadRelease({ file: piece.file, sha256: piece.sha256, size: piece.size }, cache)
  return out(cache)
}

// ── a release copied by hand (scp / USB): a folder or a .zip / .tar.gz ──────

/**
 * A signed release from a local folder or archive (2026-11-19: "copy the
 * release over the LAN by scp and apply it on Main when its internet is
 * down"). The folder is what any PC keeps (data/lan-release, or a Companion's
 * updates folder: current.json + files/<sha256>), or what
 * scripts/release-bundle.mjs makes. Its manifest must be signed by Adal and
 * every piece found must match its SHA-256; they go into this PC's cache, so
 * the install below takes them from here. Returns { manifest, signature }.
 */
export async function importRelease(src) {
  const from = path.resolve(String(src || ''))
  if (!fs.existsSync(from)) throw new Error(`not found: ${from}`)
  let dir = from, tmp = null
  try {
    if (fs.statSync(from).isFile()) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-release-'))
      // Windows 10+ has tar.exe (bsdtar), which reads .zip as well as .tar.gz.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      if (/\.zip$/i.test(from) && process.platform !== 'win32') execFileSync('unzip', ['-q', from, '-d', tmp])
      else execFileSync(tar, ['-xf', from, '-C', tmp], { windowsHide: true })
      dir = tmp
    }
    const all = []
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1) } else all.push(p)
      }
    }
    walk(dir, 0)
    let env = null
    for (const f of all.filter(f => /\.json$/i.test(f) && fs.statSync(f).size < 2 * 1048576)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (j?.manifest?.sha && verifyManifest(j.manifest, j.signature) && (!env || isNewer(j.manifest, env.manifest))) env = { manifest: j.manifest, signature: j.signature }
      } catch {}
    }
    if (!env) throw new Error('no release signed by Adal in it (current.json / latest.json)')
    const kept = []
    for (const p of piecesOf(env.manifest, { all: true })) {
      const here = pieceHere(p)
      if (here && formsOf(p).includes(path.basename(here)) && (await sha256File(here)) === path.basename(here)) { kept.push(p.sha256); continue }
      // The piece itself or its plain .tar (a PC that updated by patch keeps that one).
      for (const s of [p.sha256, p.raw?.sha256].filter(Boolean)) {
        const names = new Set([s, path.basename(p.file || ''), p.name || '', `${p.sha256}-${p.name || ''}`].filter(Boolean))
        let done = false
        for (const f of all) {
          if (!names.has(path.basename(f))) continue
          if (await keepPiece(s, f)) { kept.push(p.sha256); done = true; break }
        }
        if (done) break
      }
    }
    if (!kept.includes(env.manifest.sha256)) throw new Error(`the app itself (${path.basename(env.manifest.file || '')}, sha256 ${String(env.manifest.sha256).slice(0, 12)}…) is not in it, or does not match the signed release`)
    return { ...env, pieces: kept.length, of: piecesOf(env.manifest, { all: true }).length }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── the agency's tag (sync/peers.js: the office's PCs recognise each other by it) ──

/**
 * A hash of the agency's main PC's number (the number itself is never sent on
 * the network): another agency's PC on the same Wi-Fi is never listened to.
 */
export const agencyTag = (number) => crypto.createHash('sha256').update('adal-agency|' + String(number).replace(/\D/g, '')).digest('hex').slice(0, 16)
let ownTags = []
/** The numbers of this agency's main PC (the licence one and the older one). */
export function setAgencyNumbers(list) { ownTags = [...new Set((list || []).filter(Boolean).map(agencyTag))] }
export const agencyTags = () => ownTags
