/**
 * peerUpdate.js — a Companion newer than the main PC (installed from the USB, say) updates Main
 * (the owner, 2026-11-27: "the PCs update each other so all of them always run the same version").
 * Main → Companions is lanServe.js + adal-companion lanupdate.go; this is the way back.
 *
 * Main looks at its Companions' offers (adal-companion peerserve.go: GET :47810/peer/release, /peer/file/<sha>):
 *   • only a release signed with Adal's update key (checked here, never trusted from the Companion),
 *   • only a newer one (lanRelease.isNewer: the commit date, as .adal-version.json),
 *   • every piece fetched and checked by its SHA-256 into a folder; a piece the Companion lacks: not taken,
 *   • said in the window first (one line), installed a minute later and only while no run works (the same
 *     10-minute rule as every update), through the same install, health check and way back (applyLocalRelease).
 * Off: ADAL_PEER_UPDATES=0.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { verifyManifest } from './updateChannel.js'
import { isNewer, piecesOf } from './lanRelease.js'

export const peerUpdatesOn = () => process.env.ADAL_PEER_UPDATES !== '0'
const HEX = /^[0-9a-f]{64}$/
const ANNOUNCE_MS = () => Number(process.env.ADAL_PEER_ANNOUNCE_MS ?? 60_000)

const getJSON = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}
const getBuf = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!r.ok) throw new Error(`${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** The newest signed release the Companions offer that is newer than `mine`. → { url, name, env } or null */
export async function bestOffer(peers, mine, { get = getJSON } = {}) {
  let best = null
  for (const p of peers) {
    try {
      const env = await get(`${p.url}/peer/release`)
      if (!env?.manifest || !verifyManifest(env.manifest, env.signature)) continue
      if (!isNewer(env.manifest, mine)) continue
      if (!best || isNewer(env.manifest, best.env.manifest)) best = { ...p, env }
    } catch {}
  }
  return best
}

/** Every piece of the offer into dir/files/<sha256>, checked; dir/current.json. → true when whole. */
export async function fetchOffer(offer, dir, { get = getBuf } = {}) {
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  for (const p of piecesOf(offer.env.manifest)) {
    let ok = false
    for (const s of [p.sha256, p.raw?.sha256].filter(x => HEX.test(x || ''))) {
      try {
        const b = await get(`${offer.url}/peer/file/${s}`)
        if (crypto.createHash('sha256').update(b).digest('hex') !== s) continue
        fs.writeFileSync(path.join(dir, 'files', s), b)
        ok = true; break
      } catch {}
    }
    if (!ok) return false
  }
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ manifest: offer.env.manifest, signature: offer.env.signature }))
  return true
}

let pending = null   // { sha, at, offer }
const skipped = new Map()   // sha → until (a release a Companion could not hand whole: again in 30 minutes)
/**
 * One look (every minute, with the update watcher). deps: peers(), mine(), busy() → bool, apply(dir), notice
 * (updateNotice: .peer is the window's line). → what it did: null | 'announced' | 'waiting' | 'installed' | 'failed'
 */
export async function peerStep({ peers, mine, busy, apply, notice, now = Date.now(), get, getFile }) {
  if (!peerUpdatesOn()) return null
  const have = await mine()
  const offer = await bestOffer(await peers(), have, { get })
  if (offer && skipped.get(offer.env.manifest.sha) > now) return null
  if (!offer) { pending = null; if (notice) notice.peer = null; return null }
  const m = offer.env.manifest
  if (pending?.sha !== m.sha) {
    pending = { sha: m.sha, at: now }
    if (notice) notice.peer = { from: offer.name || offer.url, short: m.short || String(m.sha).slice(0, 7), at: new Date(now).toISOString() }
    console.log(`🆕 ${offer.name || offer.url} runs a newer Adal Keep (${m.short || m.sha}): it is installed here in a minute, when no run works`)
    return 'announced'
  }
  if (now - pending.at < ANNOUNCE_MS() || await busy()) return 'waiting'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-peer-'))
  try {
    if (!(await fetchOffer(offer, dir, { get: getFile }))) { console.warn(`[peer-update] ${offer.name || offer.url} does not keep every piece of ${m.short}: not taken`); skipped.set(m.sha, now + 30 * 60_000); pending = null; if (notice) notice.peer = null; return 'failed' }
    const r = await apply(dir)
    console.log(`[peer-update] ${m.short} from ${offer.name || offer.url}: ${r?.error || r?.message || 'done'}`)
    pending = null
    if (notice) notice.peer = null
    return r?.error ? 'failed' : 'installed'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
export const _resetPeerForTests = () => { pending = null; skipped.clear() }
