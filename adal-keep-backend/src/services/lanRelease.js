/**
 * lanRelease.js — every PC of the office helps the others update (asked on 2026-11-19).
 *
 * Supabase stays the source of truth: each PC still reads Adal's signed
 * release there (updateChannel.js). On top of it, a PC that has a release
 * installed tells the others on the office network, and serves its signed
 * pieces to them:
 *
 *   UDP 45455 (broadcast)   ADAL_KEEP_RELEASE_V1|<sha>|<published_at>|<port>|<path>
 *   GET <base>/latest       { manifest, signature } — the release this PC has
 *   GET <base>/file/<sha256> one piece of it (the app, a program, the Companion's pages)
 *
 * (Main PC: base http://<ip>:4000/api/system/update/lan; an Adal Companion:
 * http://<ip>:47810/lan, served by adal-companion.exe.)
 *
 * Whoever hears of a newer release (published later, another sha — the same
 * sha is never fetched again, so nothing goes round in circles) asks for the
 * manifest, checks Adal's signature, downloads the pieces from that PC and
 * checks each SHA-256 against the signed manifest. Anything unsigned or
 * changed is thrown away. Once installed, it tells the others in turn.
 */
import crypto from 'crypto'
import dgram from 'dgram'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifyManifest, downloadRelease } from './updateChannel.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const DIR = process.env.ADAL_LAN_RELEASE_DIR || path.join(DATA, 'lan-release')
const FILES = path.join(DIR, 'files')
const CURRENT = path.join(DIR, 'current.json')
export const UDP_PORT = Number(process.env.ADAL_RELEASE_UDP || 45455)
const MAGIC = 'ADAL_KEEP_RELEASE_V1'
const HEX = /^[0-9a-f]{64}$/

/** Peers heard on the network: base → { sha, published_at, at }. */
export const peers = new Map()
let afterNews = () => {}

export function current() {
  try {
    const env = JSON.parse(fs.readFileSync(CURRENT, 'utf8'))
    return env?.manifest && verifyManifest(env.manifest, env.signature) ? env : null
  } catch { return null }
}

/** The pieces of a manifest, by SHA-256: the app, the programs, the Companion's pages. */
export function piecesOf(m) {
  const out = []
  if (m?.sha256 && m.file) out.push({ file: m.file, sha256: m.sha256 })
  for (const p of m?.programs || []) if (p?.sha256) out.push({ file: p.file, sha256: p.sha256, name: p.name })
  if (m?.online?.sha256) out.push({ file: m.online.file, sha256: m.online.sha256 })
  return out
}

const sha256Of = (file) => new Promise((ok, no) => {
  const h = crypto.createHash('sha256')
  fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', no)
})

/** A piece kept here to hand on (only one the signed manifest names, checked). */
export async function keepPiece(sha256, from) {
  if (!HEX.test(sha256) || !fs.existsSync(from)) return false
  if ((await sha256Of(from)) !== sha256) return false
  fs.mkdirSync(FILES, { recursive: true })
  const dest = path.join(FILES, sha256)
  if (path.resolve(from) !== path.resolve(dest)) fs.copyFileSync(from, dest)
  return true
}
export const piecePath = (sha256) => HEX.test(sha256) && fs.existsSync(path.join(FILES, sha256)) ? path.join(FILES, sha256) : null

/**
 * The release now installed here: kept (signed) to hand on, its pieces that
 * are here kept too (the programs as installed), the rest of the cache
 * dropped. Then the others on the network are told.
 */
export async function recordInstalled(env, projectRoot = '') {
  if (!env?.manifest || !verifyManifest(env.manifest, env.signature)) return false
  fs.mkdirSync(FILES, { recursive: true })
  fs.writeFileSync(CURRENT, JSON.stringify({ manifest: env.manifest, signature: env.signature }))
  for (const p of env.manifest.programs || []) {
    if (projectRoot && p.name && !piecePath(p.sha256)) await keepPiece(p.sha256, path.join(projectRoot, p.name)).catch(() => {})
  }
  const wanted = new Set(piecesOf(env.manifest).map(p => p.sha256))
  for (const f of fs.readdirSync(FILES)) if (!wanted.has(f)) fs.rmSync(path.join(FILES, f), { force: true })
  // The Companion's pages: small, fetched once from Supabase (or a peer) so the Companions can have them here.
  const online = env.manifest.online
  if (online?.sha256 && !piecePath(online.sha256)) fetchPiece(env.manifest, online, path.join(FILES, online.sha256)).catch(() => {})
  announce()
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

async function getJSON(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: 'no-store' })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

/** One piece from a peer on the network, checked against the signed manifest's SHA-256. */
export async function pieceFromPeer(base, sha256, dest) {
  const r = await fetch(`${base}/file/${sha256}`, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!r.ok) throw new Error(`peer answered ${r.status}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
  if ((await sha256Of(dest)) !== sha256) { fs.rmSync(dest, { force: true }); throw new Error('the piece from the network does not match the signed release') }
  return dest
}

/** The peers that have this release (same sha). */
export const peersWith = (sha) => [...peers].filter(([, p]) => p.sha === sha && Date.now() - p.at < 3600 * 1000).map(([b]) => b)

/**
 * A piece of a signed release: from a PC on the network that has it (fast,
 * no internet), else from Supabase. Checked either way.
 */
export async function fetchPiece(manifest, piece, dest) {
  for (const base of peersWith(manifest.sha)) {
    try { await pieceFromPeer(base, piece.sha256, dest); console.log(`[lan-update] ${path.basename(piece.file || piece.sha256)} from ${base}`); return dest } catch {}
  }
  await downloadRelease({ file: piece.file, sha256: piece.sha256 }, dest)
  return dest
}

/** A peer's envelope that is signed and newer than `than`. */
export const verifyIsNewer = (env, than) => !!env?.manifest && verifyManifest(env.manifest, env.signature) && isNewer(env.manifest, than)

/** The newest signed release a peer has that is newer than `than` ({ manifest, signature, base } or null). */
export async function newestFromPeers(than) {
  let best = null
  for (const [base, p] of peers) {
    if (Date.now() - p.at > 3600 * 1000 || !isNewer(p, best?.manifest || than)) continue
    try {
      const env = await getJSON(`${base}/latest`)
      if (env?.manifest?.sha === p.sha && verifyManifest(env.manifest, env.signature) && isNewer(env.manifest, best?.manifest || than)) best = { ...env, base }
    } catch {}
  }
  return best
}

// ── telling and hearing ────────────────────────────────────────────────────
let sock = null
let ownPort = 4000

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

/** "I have release X": to every PC of this network. */
export function announce() {
  const env = current()
  if (!sock || !env) return
  const msg = Buffer.from([MAGIC, env.manifest.sha, env.manifest.published_at || '', ownPort, '/api/system/update/lan'].join('|'))
  for (const addr of broadcastAddrs()) {
    const [host, port] = addr.includes(':') ? addr.split(':') : [addr, UDP_PORT]
    sock.send(msg, Number(port), host, () => {})
  }
}

/** A message heard: a peer's release. True when it is newer than this PC's (and worth a look). */
export function heard(text, fromIp) {
  const [magic, sha, published_at, port, p] = String(text).trim().split('|')
  if (magic !== MAGIC || !/^[0-9a-f]{7,64}$/.test(sha || '') || !/^\d+$/.test(port || '') || !/^\/[\w/-]*$/.test(p || '')) return false
  const host = fromIp.includes(':') ? `[${fromIp}]` : fromIp
  const base = `http://${host}:${port}${p.replace(/\/$/, '')}`
  peers.set(base, { sha, published_at, at: Date.now() })
  const mine = current()?.manifest
  return isNewer({ sha, published_at }, mine)
}

/** Starts telling and hearing; onNews runs when a peer has a newer release. */
export function startLan({ port = 4000, onNews } = {}) {
  if (sock || process.env.ADAL_LAN_UPDATES === '0') return
  ownPort = Number(process.env.PORT || port)
  if (onNews) afterNews = onNews
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', (e) => { console.warn('[lan-update]', e.message); try { sock.close() } catch {} sock = null })
  sock.on('message', (msg, rinfo) => {
    const own = Object.values(os.networkInterfaces()).flat().some(a => a?.address === rinfo.address) && Number(String(msg).split('|')[3]) === ownPort
    if (own) return
    if (heard(msg, rinfo.address)) { console.log(`[lan-update] ${rinfo.address} has a newer release (${String(msg).split('|')[1].slice(0, 7)})`); afterNews() }
  })
  sock.bind(UDP_PORT, () => { try { sock.setBroadcast(true) } catch {} ; setTimeout(announce, 3000) })
  setInterval(announce, 10 * 60 * 1000).unref?.()
}

/** The routes: what this PC has, and its pieces (only those its signed manifest names). */
export function lanRoutes(router) {
  router.get('/update/lan/latest', (req, res) => {
    const env = current()
    if (!env) return res.status(404).json({ error: 'No release kept here yet' })
    res.json(env)
  })
  router.get('/update/lan/file/:sha', (req, res) => {
    const env = current()
    const sha = String(req.params.sha || '')
    if (!env || !piecesOf(env.manifest).some(p => p.sha256 === sha)) return res.status(404).end()
    const file = piecePath(sha)
    if (!file) return res.status(404).end()
    res.setHeader('Content-Type', 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
}
