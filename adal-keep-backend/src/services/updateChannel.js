/**
 * Adal Keep's updates from Supabase (adal-admin/supabase/updates.sql), so the
 * GitHub repository can be private. Adal publishes with
 * scripts/publish-update.mjs; every PC reads with its own agency sign-in.
 *
 *   adal-updates/release/latest.json   { manifest, signature }
 *   adal-updates/release/<sha>.tar.gz  the app (backend code + built frontend)
 *
 * Nothing is installed unless Adal's signature (Ed25519, the private key only
 * on Adal's PC: ~/.adal-keep/update-signing.pem) matches the manifest, and the
 * download's SHA-256 matches the manifest.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'

export const BUCKET = 'adal-updates'
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAimpnKnJzVGiLNH27Lkf4b2aCJoLOpL1fQuqF/gM1HTo=
-----END PUBLIC KEY-----`
// Tests only (in-process: never from the network, a file or the environment): a throw-away key.
let verifyKey = PUBLIC_KEY
export const _setVerifyKeyForTests = (pem) => { verifyKey = pem || PUBLIC_KEY }

/** The same text on every PC for the same manifest (sorted keys). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function signManifest(manifest, privateKeyPem) {
  return crypto.sign(null, Buffer.from(canonical(manifest)), privateKeyPem).toString('base64')
}

export function verifyManifest(manifest, signature) {
  try { return crypto.verify(null, Buffer.from(canonical(manifest)), verifyKey, Buffer.from(String(signature || ''), 'base64')) } catch { return false }
}

/**
 * A signed release can name the PCs that may take it from Supabase
 * (manifest.audience.pcs = PC names, as os.hostname()): Adal seeds one
 * Companion with it and the others get it from that Companion over the office
 * network (services/lanRelease.js). Only Supabase is held back: a signed
 * release offered by a PC of the office is taken by anyone (checked as ever).
 */
export const myHost = () => os.hostname().toLowerCase()
export function audienceAllows(manifest, host = myHost()) {
  const pcs = manifest?.audience?.pcs
  if (!Array.isArray(pcs) || !pcs.length) return true
  return pcs.some(n => String(n).toLowerCase() === String(host).toLowerCase())
}

let dbRef = null
export const setUpdateDb = (db) => { if (db) dbRef = db }

async function cloud() {
  const c = await import('./chatCloud.js')
  if (!c.chatConfigured()) throw new Error('Supabase is not set up on this PC')
  return c
}

/** The signed release last read from Supabase ({ manifest, signature }): kept to hand on to the office's other PCs. */
export let lastEnvelope = null

const wait = (ms) => new Promise(r => setTimeout(r, ms))

/** The newest signed release, or an error that says why not (a slow line gets 3 tries). */
export async function latestRelease(channel = 'release') {
  const { cloudCall } = await cloud()
  let res = null, lastErr = null
  for (let i = 0; i < 3 && !res; i++) {
    try { res = await cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${channel}/latest.json`, undefined, { raw: true, timeout: 45_000, headers: { 'Cache-Control': 'no-cache' } }) }
    catch (e) { lastErr = e; if (i < 2) await wait(2000 * (i + 1)) }
  }
  if (!res) throw lastErr
  if (!res.ok) throw new Error(`Supabase updates answered ${res.status}${res.status === 400 || res.status === 404 ? ' (nothing published yet, or updates.sql not run)' : ''}`)
  const { manifest, signature } = await res.json()
  if (!manifest?.sha || !verifyManifest(manifest, signature)) throw new Error('The published update is not signed by Adal — not installed')
  if (!audienceAllows(manifest)) throw Object.assign(new Error('The newest release is being tried on other PCs first'), { audience: true })
  lastEnvelope = { manifest, signature }
  return manifest
}

/** A small signed file of the release folder (release/assign.json: Admin's decisions), or null. */
export async function readSigned(name, channel = 'release') {
  const { cloudCall } = await cloud()
  const res = await cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${channel}/${name}`, undefined, { raw: true, timeout: 20_000, headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) return null
  const env = await res.json().catch(() => null)
  return env?.manifest && verifyManifest(env.manifest, env.signature) ? env : null
}

export const sha256File = (file) => new Promise((ok, no) => {
  const h = crypto.createHash('sha256')
  fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', no)
})

/**
 * A download that survives a slow or dropping line (2026-11-19: the main PC's
 * update was cut off by one timeout). It goes in pieces (Range requests) into
 * `<dest>.part`, which stays between tries and between updates, so every try
 * goes on from where the last one stopped. Each piece has its own timeout, a
 * failed piece is tried again after a growing wait, and only many tries in a
 * row with no progress at all give up. A server that ignores Range sends the
 * whole file: read while it keeps sending (a stall, not the total time, ends it).
 * The finished file must match `want` (SHA-256), else it is thrown away.
 *
 *   open(start, end, signal) → a fetch Response (206 for the range, or 200 for all)
 */
const defaults = { chunk: 2 * 1048576, timeout: 180_000, stall: 60_000, tries: 6, backoff: 2000 }
/** Tests only: shorter waits. */
export const _setDownloadDefaultsForTests = (o) => Object.assign(defaults, o)

export async function rangedDownload(open, dest, want, opts = {}) {
  const { chunk, timeout, stall, tries, backoff, size } = { ...defaults, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }
  const part = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const have = () => { try { return fs.statSync(part).size } catch { return 0 } }
  // A .part that is already the whole piece (a download that was cut or hung just after its last byte,
  // 2026-11-22): finished here, with no request at all, when its SHA-256 is the signed one.
  if (have() > 0 && (!size || have() === size) && (await sha256File(part).catch(() => '')) === want) {
    fs.renameSync(part, dest)
    return dest
  }
  let total = Number(size) > 0 ? Number(size) : 0, failures = 0
  for (;;) {
    const before = have()
    if (total && before >= total) break
    let lastErr = null
    const ac = new AbortController()
    let timer = setTimeout(() => ac.abort(new Error(`no answer in ${timeout / 1000}s`)), timeout)
    const restartStall = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error('stalled')), stall) }
    try {
      const res = await open(before, before + chunk - 1, ac.signal)
      if (res.status === 416) { // asked past the end: all of it is here
        if (!total) total = before
        break
      }
      if (res.status !== 206 && res.status !== 200) {
        // Not there / not allowed: no use asking again (a busy or broken server is asked again).
        if (res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status)) throw Object.assign(new Error(`answered ${res.status}`), { final: true })
        throw new Error(`answered ${res.status}`)
      }
      const ranged = res.status === 206
      restartStall() // from here on a body that stops sending for `stall` ms is cut (no CLOSE_WAIT socket waits for ever)
      if (ranged) {
        const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/.exec(res.headers.get('content-range') || '')
        if (!m || Number(m[1]) !== before) throw new Error('the server sent another part than asked')
        if (m[2] !== '*') total = Number(m[2])
      } else {
        // The whole file from the start: what was here is replaced; a stall ends it, not the total time.
        total = Number(res.headers.get('content-length')) || 0
      }
      const ws = fs.createWriteStream(part, { flags: ranged ? 'a' : 'w' })
      try {
        for await (const c of Readable.fromWeb(res.body)) {
          restartStall()
          if (!ws.write(c)) await new Promise(r => ws.once('drain', r))
        }
      } finally {
        await new Promise(r => ws.end(r))
      }
      if (!ranged && !total) total = have() // no length given: what came is all of it
      if (!ranged && have() < total) throw new Error('cut off')
    } catch (e) { lastErr = e } finally { clearTimeout(timer) }
    if (total && have() > total) { fs.rmSync(part, { force: true }); total = 0 } // nonsense: from the start again
    if (have() > before) failures = 0 // progress: the count starts again
    else if (lastErr) {
      if (lastErr.final) throw new Error(`download failed: ${lastErr.message}`)
      if (++failures >= tries) throw new Error(`download stopped after ${failures} tries with no progress: ${lastErr.message}`)
      await wait(Math.min(60_000, backoff * 2 ** (failures - 1)))
    } else if (++failures >= tries) throw new Error('download stopped: no data')
  }
  const got = await sha256File(part)
  if (got !== want) { fs.rmSync(part, { force: true }); throw new Error('The download does not match Adal\'s signed release (damaged or changed) — not installed') }
  fs.renameSync(part, dest)
  return dest
}

/** Downloads one piece of the release from Supabase to `dest` (in pieces, resumable) and checks its SHA-256. */
export async function downloadRelease(manifest, dest, opts = {}) {
  const { cloudCall } = await cloud()
  const url = `/storage/v1/object/authenticated/${BUCKET}/${manifest.file}`
  return rangedDownload((start, end, signal) => cloudCall(dbRef, 'GET', url, undefined, { raw: true, timeout: opts.timeout || 180_000, signal, headers: { Range: `bytes=${start}-${end}` } }), dest, manifest.sha256, { size: manifest.size, ...opts })
}
