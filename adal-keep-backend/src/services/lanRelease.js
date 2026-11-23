/**
 * lanRelease.js — every PC of the office helps the others update (asked on 2026-11-19).
 *
 * Supabase stays the source of truth for what a release IS (Adal's signature),
 * but not the only place to get one: every PC (the main PC and each Adal
 * Companion) keeps the COMPLETE signed release it installed — the manifest and
 * every piece: the app (backend + built pages), every program, the Companion's
 * online pages — and serves it on the office network:
 *
 *   UDP 45455 (broadcast)    ADAL_KEEP_RELEASE_V1|<sha>|<published_at>|<port>|<path>|<agency tags>
 *   GET  <base>/latest       { manifest, signature, have } — the release kept here
 *   GET  <base>/file/<sha256> one piece of it (Range requests work: a cut line goes on)
 *   POST <base>/offer        { sha, published_at, port, path, tags } — "I have a newer one"
 *
 * (Main PC: base http://<ip>:4000/api/system/update/lan; an Adal Companion:
 * http://<ip>:47810/lan, served by adal-companion.exe.)
 *
 * Whoever hears of a newer release (published later, another sha — the same
 * sha is never fetched again, so nothing goes round in circles) asks for the
 * manifest, checks Adal's signature, downloads the pieces from that PC and
 * checks each SHA-256 against the signed manifest. Anything unsigned, older,
 * or from another agency is thrown away. Once installed, it tells the others.
 *
 * 2026-11-19 (the main PC's internet timed out on the download while a
 * Companion on the same Wi-Fi had the newer release): the office is asked
 * FIRST, Supabase second; a failed Supabase download falls back to the
 * office at once; a Companion pushes its newer release to the main PC (and
 * the main PC to its Companions) with POST /offer, not only by broadcast.
 */
import crypto from 'crypto'
import dgram from 'dgram'
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
export const UDP_PORT = Number(process.env.ADAL_RELEASE_UDP || 45455)
const MAGIC = 'ADAL_KEEP_RELEASE_V1'
const HEX = /^[0-9a-f]{64}$/
const COMPANION_PORT = Number(process.env.ADAL_LAN_HTTP || 47810)

/** Peers heard on the network: base → { sha, published_at, at }. */
export const peers = new Map()
let afterNews = () => {}

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
  const delta = (p) => ({ ...(form(p?.raw) ? { raw: p.raw } : {}), ...(form(p?.patch) && p.patch.file ? { patch: p.patch } : {}) })
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
/** A peer's `have` list holds this piece in some form (the patch alone does not count). */
const peerHas = (have, p) => have.includes(p.sha256) || (p.raw && have.includes(p.raw.sha256))

/**
 * The release now installed here: kept (signed) to hand on, its pieces that
 * are here kept too (the programs as installed), the rest of the cache
 * dropped. The missing pieces are fetched behind (the office first, then
 * Supabase), so this PC can hand the WHOLE release on. Then the office is told.
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
  completeRelease(env).catch(e => console.warn('[lan-update] the whole release is not here yet:', e.message))
  announce()
  offerToKnown()
  return true
}

let completing = null
/** Every piece of the kept release fetched (the office first, then Supabase), tried again for a few hours. */
export function completeRelease(env, { tries = 6, every = 10 * 60 * 1000 } = {}) {
  if (completing?.sha === env.manifest.sha) return completing.p
  const p = (async () => {
    for (let i = 0; i < tries; i++) {
      if (current()?.manifest?.sha !== env.manifest.sha) return false // another release came meanwhile
      let missing = 0
      for (const piece of piecesOf(env.manifest)) {
        if (pieceHere(piece)) continue
        try { await fetchPiece(env.manifest, piece, null) } catch { missing++ }
      }
      if (!missing) { console.log(`[lan-update] the whole release ${env.manifest.short || env.manifest.sha.slice(0, 7)} is here to hand on`); announce(); offerToKnown(); return true }
      await new Promise(r => setTimeout(r, every).unref?.())
    }
    return false
  })().finally(() => { if (completing?.p === p) completing = null })
  completing = { sha: env.manifest.sha, p }
  return p
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

async function getJSON(url, timeout = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

/** One piece from a peer on the network (resumable), checked against the signed manifest's SHA-256. */
export async function pieceFromPeer(base, sha256, dest, size) {
  return rangedDownload((start, end, signal) => fetch(`${base}/file/${sha256}`, { signal, headers: { Range: `bytes=${start}-${end}` } }),
    dest, sha256, { chunk: 16 * 1048576, timeout: 120_000, tries: 3, backoff: 500, size })
}

/** The peers that have this release (same sha). */
export const peersWith = (sha) => [...peers].filter(([, p]) => p.sha === sha && Date.now() - p.at < 3600 * 1000).map(([b]) => b)

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
 * The piece rebuilt from the release before + its small patch (the office
 * first, then Supabase): its plain .tar (or the program itself) lands in the
 * cache, checked against the signed SHA-256. Null when there is no base here.
 */
async function viaPatch(manifest, piece, { bases = [], cloud = true, local = [] } = {}) {
  const pt = piece.patch
  const base = await patchBase(pt, local)
  if (!base) return null
  const target = piece.raw?.sha256 || piece.sha256
  const pfile = path.join(FILES, pt.sha256)
  let lastErr = null, got = !!piecePath(pt.sha256)
  for (const b of got ? [] : [...new Set([...bases, ...peersWith(manifest.sha)])]) {
    try { await pieceFromPeer(b, pt.sha256, pfile, pt.size); got = true; break } catch (e) { lastErr = e }
  }
  if (!got) {
    if (!cloud) throw lastErr || new Error('no PC of the office has the patch')
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
 * from the release before and a small patch, else the whole piece from a PC
 * on the network that has it (fast, no internet; `bases` first), else from
 * Supabase (resumable, unless cloud is false). It lands in this PC's cache
 * (so it is handed on too) and is copied to `dest` when one is given — the
 * .tar.gz or the plain .tar (tar -xf reads both). Checked every time.
 * `local`: files on this PC a program patch may start from (the installed program).
 */
export async function fetchPiece(manifest, piece, dest, { bases = [], cloud = true, local = [] } = {}) {
  if (!HEX.test(piece?.sha256 || '')) throw new Error('bad piece')
  fs.mkdirSync(FILES, { recursive: true })
  // The full description from the signed manifest (callers may pass only file + sha256).
  piece = { ...(piecesOf(manifest, { all: true }).find(p => p.sha256 === piece.sha256) || {}), ...piece }
  const out = (from) => { if (dest && path.resolve(dest) !== path.resolve(from)) fs.copyFileSync(from, dest); return dest || from }
  for (const s of [piece.sha256, piece.raw?.sha256]) {
    const hit = piecePath(s)
    if (hit && (await sha256File(hit)) === s) return out(hit)
  }
  const label = path.basename(piece.file || piece.sha256)
  if (piece.patch && deltaOn()) {
    try {
      const r = await viaPatch(manifest, piece, { bases, cloud, local })
      if (r) { console.log(`[lan-update] ${label} rebuilt from the version before + a ${(r.bytes / 1024).toFixed(0)} KB patch`); return out(r.file) }
    } catch (e) { console.warn(`[lan-update] ${label}: the patch did not work (${e.message}) — the whole piece instead`) }
  }
  let lastErr = null
  for (const base of [...new Set([...bases, ...peersWith(manifest.sha)])]) {
    for (const s of [piece.raw?.sha256, piece.sha256].filter(Boolean)) {
      try {
        const file = path.join(FILES, s)
        await pieceFromPeer(base, s, file, s === piece.sha256 ? piece.size : piece.raw.size)
        console.log(`[lan-update] ${label} from ${base}`)
        return out(file)
      } catch (e) { lastErr = e }
    }
  }
  if (!cloud) throw lastErr || new Error('no PC of the office has it')
  const cache = path.join(FILES, piece.sha256)
  try { await downloadRelease({ file: piece.file, sha256: piece.sha256, size: piece.size }, cache) } catch (e) {
    throw lastErr ? new Error(`${e.message} (the office: ${lastErr.message})`) : e
  }
  return out(cache)
}

/** A peer's envelope that is signed and newer than `than`. */
export const verifyIsNewer = (env, than) => !!env?.manifest && verifyManifest(env.manifest, env.signature) && isNewer(env.manifest, than)

/**
 * Bases of this agency's Companions the main PC knows (Settings → Connected
 * devices): asked directly too, in case the Wi-Fi does not pass broadcasts.
 */
export async function knownBases() {
  const out = []
  try {
    for (const p of (await import('./networkGate.js')).list()) {
      const ip = String(p.ip || '')
      if (p.suspended || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip.startsWith('127.')) continue
      out.push(`http://${ip}:${COMPANION_PORT}/lan`)
    }
  } catch {}
  for (const t of String(process.env.ADAL_RELEASE_BASES || '').split(',').map(s => s.trim()).filter(Boolean)) out.push(t.replace(/\/$/, ''))
  return [...new Set(out)]
}

/**
 * The newest signed release a PC of the office has that is newer than `than`
 * ({ manifest, signature, base, complete } or null). Peers heard of and the
 * known Companions are asked; a peer that has every piece wins a tie.
 */
export async function newestFromPeers(than, { extra = true, skip = [] } = {}) {
  const bases = new Set([...peers].filter(([, p]) => Date.now() - p.at < 3600 * 1000).map(([b]) => b))
  if (extra) for (const b of await knownBases()) bases.add(b)
  for (const b of skip) bases.delete(b)
  const answers = await Promise.all([...bases].map(async (base) => {
    try {
      const env = await getJSON(`${base}/latest`, 4000)
      if (!env?.manifest || !verifyManifest(env.manifest, env.signature)) return null
      peers.set(base, { sha: env.manifest.sha, published_at: env.manifest.published_at || '', at: Date.now() })
      const complete = piecesOf(env.manifest).every(p => peerHas(env.have || [], p))
      return { manifest: env.manifest, signature: env.signature, base, complete, have: env.have || [] }
    } catch { return null }
  }))
  let best = null
  for (const a of answers) {
    if (!a || !isNewer(a.manifest, than)) continue
    if (!best || isNewer(a.manifest, best.manifest) || (a.manifest.sha === best.manifest.sha && a.complete && !best.complete)) best = a
  }
  return best
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

// ── telling and hearing ────────────────────────────────────────────────────
let sock = null
let ownPort = 4000

/**
 * Whose offer it is (2026-11-19: another agency's PC on the same Wi-Fi must
 * never be offered anything or listened to). Every offer carries the agency's
 * tag(s): a hash of its main PC's number(s) (the number itself is never
 * broadcast). An offer is heard only when one of its tags is this agency's.
 */
export const agencyTag = (number) => crypto.createHash('sha256').update('adal-agency|' + String(number).replace(/\D/g, '')).digest('hex').slice(0, 16)
let ownTags = []
/** The numbers of this agency's main PC (the licence one and the older one). */
export function setAgencyNumbers(list) { ownTags = [...new Set((list || []).filter(Boolean).map(agencyTag))] }
export const agencyTags = () => ownTags
async function loadAgencyNumbers() {
  const list = []
  try { list.push((await import('./subscription.js')).pcNumber()) } catch {}
  try { list.push((await import('./mainPC.js')).pcNumber()) } catch {}
  setAgencyNumbers(list)
}

function broadcastAddrs() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || !a.netmask) continue
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number)
    out.add(ip.map((n, i) => (n | (~m[i] & 255))).join('.'))
  }
  if (process.env.ADAL_RELEASE_PEERS) for (const t of process.env.ADAL_RELEASE_PEERS.split(',')) out.add(t.trim())
  return [...out]
}

const LAN_PATH = '/api/system/update/lan'

/** "I have release X": to every PC of this network. */
export function announce() {
  const env = current()
  if (!sock || !env || !ownTags.length) return // no agency known: nothing is offered
  const msg = Buffer.from([MAGIC, env.manifest.sha, env.manifest.published_at || '', ownPort, LAN_PATH, ownTags.join(',')].join('|'))
  for (const addr of broadcastAddrs()) {
    const [host, port] = addr.includes(':') ? addr.split(':') : [addr, UDP_PORT]
    sock.send(msg, Number(port), host, () => {})
  }
}

/**
 * The same offer, straight to each Companion this PC knows (POST <base>/offer):
 * the Wi-Fi may drop broadcasts, the Companion picks it up at once.
 */
export async function offerToKnown(bases = null) {
  const env = current()
  if (!env || !ownTags.length || !completeHere(env.manifest)) return 0
  const body = JSON.stringify({ sha: env.manifest.sha, published_at: env.manifest.published_at || '', seq: env.manifest.seq || 0, port: ownPort, path: LAN_PATH, tags: ownTags.join(',') })
  let told = 0
  for (const base of bases || await knownBases()) {
    try {
      const r = await fetch(`${base}/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(4000) })
      if (r.ok) told++
    } catch {}
  }
  return told
}

const newsAt = new Map()
/** A peer has a newer release: the update check runs at its next minute (once per release per 5 minutes). */
function news(sha) {
  const t = newsAt.get(sha) || 0
  if (Date.now() - t < 5 * 60 * 1000) return false
  newsAt.set(sha, Date.now())
  try { afterNews(sha) } catch {}
  return true
}

/** A message heard: a peer's release. True when it is newer than this PC's (and worth a look). */
export function heard(text, fromIp) {
  const [magic, sha, published_at, port, p, tags] = String(text).trim().split('|')
  if (magic !== MAGIC || !/^[0-9a-f]{7,64}$/.test(sha || '') || !/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65535 || !/^\/[\w/-]*$/.test(p || '')) return false
  // Another agency's PC (or an old one that does not say whose it is): never listened to.
  if (!ownTags.length || !String(tags || '').split(',').some(t => ownTags.includes(t))) return false
  const ip = String(fromIp || '').replace(/^::ffff:/, '')
  if (!ip) return false
  const host = ip.includes(':') ? `[${ip}]` : ip
  const base = `http://${host}:${port}${p.replace(/\/$/, '')}`
  peers.set(base, { sha, published_at, at: Date.now() })
  return isNewer({ sha, published_at }, installedNow())
}

/** What this PC runs (its kept release, else what the update marker says): set by systemUpdate.js. */
let installedOf = () => current()?.manifest || null
export const setInstalledOf = (fn) => { if (typeof fn === 'function') installedOf = fn }
const installedNow = () => { try { return installedOf() } catch { return current()?.manifest || null } }

/** Starts telling and hearing; onNews runs when a peer has a newer release. */
export function startLan({ port = 4000, onNews } = {}) {
  if (onNews) afterNews = onNews
  if (sock || process.env.ADAL_LAN_UPDATES === '0') return
  ownPort = Number(process.env.PORT || port)
  loadAgencyNumbers().then(() => setTimeout(announce, 1000))
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', (e) => { console.warn('[lan-update]', e.message); try { sock.close() } catch {} sock = null })
  sock.on('message', (msg, rinfo) => {
    const own = Object.values(os.networkInterfaces()).flat().some(a => a?.address === rinfo.address) && Number(String(msg).split('|')[3]) === ownPort
    if (own) return
    if (heard(msg, rinfo.address) && news(String(msg).split('|')[1])) console.log(`[lan-update] ${rinfo.address} has a newer release (${String(msg).split('|')[1].slice(0, 7)})`)
  })
  sock.bind(UDP_PORT, () => { try { sock.setBroadcast(true) } catch {} ; setTimeout(announce, 3000) })
  setInterval(() => { announce(); offerToKnown().catch(() => {}) }, 5 * 60 * 1000).unref?.()
  // A release kept from before this version (pieces missing): made whole behind.
  setTimeout(() => { const env = current(); if (env && !completeHere(env.manifest)) completeRelease(env).catch(() => {}) }, 2 * 60 * 1000).unref?.()
}

/** The routes: what this PC has, its pieces (only those its signed manifest names), and offers. */
export function lanRoutes(router) {
  router.get('/update/lan/latest', (req, res) => {
    const env = current()
    if (!env) return res.status(404).json({ error: 'No release kept here yet' })
    res.json({ ...env, have: haveOf(env.manifest) })
  })
  router.get('/update/lan/file/:sha', (req, res) => {
    const env = current()
    const sha = String(req.params.sha || '')
    if (!env || !piecesOf(env.manifest, { all: true }).some(p => formsOf(p).includes(sha))) return res.status(404).end()
    const file = piecePath(sha)
    if (!file) return res.status(404).end()
    // sendFile answers Range requests (206): a cut download goes on where it stopped.
    res.sendFile(path.resolve(file), { headers: { 'Content-Type': 'application/octet-stream' }, dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) res.status(404).end() })
  })
  // A PC of this agency says it has a newer release (a Companion pushing to the main PC).
  router.post('/update/lan/offer', (req, res) => {
    const b = req.body || {}
    const ip = String(req.socket?.remoteAddress || '')
    const line = [MAGIC, String(b.sha || ''), String(b.published_at || ''), String(b.port || ''), String(b.path || ''), String(b.tags || '')].join('|')
    const newer = heard(line, ip)
    if (newer && news(String(b.sha))) console.log(`[lan-update] ${ip.replace(/^::ffff:/, '')} offers a newer release (${String(b.sha).slice(0, 7)})`)
    res.json({ ok: true, newer })
  })
}
