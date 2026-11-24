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
const DOWN = /ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/
/** The error says this PC has no route out (not a slow line): trying again at once does not help. */
export function netDown(e) {
  for (let x = e, i = 0; x && i < 4; x = x.cause, i++) if (DOWN.test(String(x.code || '')) || DOWN.test(String(x.message || ''))) return true
  return false
}

/** The newest signed release, or an error that says why not (a slow line gets 3 tries). */
export async function latestRelease(channel = 'release') {
  const { cloudCall } = await cloud()
  let res = null, lastErr = null
  for (let i = 0; i < 3 && !res; i++) {
    try { res = await cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${channel}/latest.json`, undefined, { raw: true, timeout: 45_000, headers: { 'Cache-Control': 'no-cache' } }) }
    catch (e) {
      lastErr = e
      // No way out to the internet at all (ENETUNREACH …): no more tries — the office network
      // is asked instead (lanRelease), and the check is not held up for minutes (2026-11-23).
      if (netDown(e)) break
      if (i < 2) await wait(2000 * (i + 1))
    }
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

// One download per file at a time (2026-11-24: two automatic installs wrote into the same .part on
// Main, which never finished): a second caller waits for the first and gets its result.
const downloading = new Map()
export function rangedDownload(open, dest, want, opts = {}) {
  const key = path.resolve(dest)
  if (downloading.has(key)) return downloading.get(key)
  const job = rangedDownloadOnce(open, dest, want, opts).finally(() => downloading.delete(key))
  downloading.set(key, job)
  return job
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
async function rangedDownloadOnce(open, dest, want, opts = {}) {
  const { chunk, timeout, stall, tries, backoff, size, log = console } = { ...defaults, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }
  const part = `${dest}.part`
  const name = opts.label || path.basename(dest).slice(0, 12)
  let lastSaid = 0
  const say = (force = false) => { if (force || Date.now() - lastSaid > 30_000) { lastSaid = Date.now(); log.log?.(`[update] download ${name}: ${mb(have())}${total ? ` of ${mb(total)}` : ''}`) } }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const have = () => { try { return fs.statSync(part).size } catch { return 0 } }
  // A .part that is already the whole piece (a download that was cut or hung just after its last byte,
  // 2026-11-22): finished here, with no request at all, when its SHA-256 is the signed one.
  if (have() > 0 && (!size || have() === size) && (await sha256File(part).catch(() => '')) === want) {
    fs.renameSync(part, dest)
    return dest
  }
  let total = Number(size) > 0 ? Number(size) : 0, failures = 0
  if (have() > 0) log.log?.(`[update] download ${name}: going on from ${mb(have())}${total ? ` of ${mb(total)}` : ''}`)
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
        // The whole file from the start (the server did not take the Range): the bytes already
        // here are kept, the same ones from the stream are skipped — never back to zero
        // (2026-11-24: Main's 16.8 MB download went back to 0 at 15 MB, again and again).
        total = Number(res.headers.get('content-length')) || 0
        if (before) log.warn?.(`[update] download ${name}: the server sent the whole file (no Range) — the first ${mb(before)} already here are skipped`)
      }
      let skip = ranged ? 0 : before
      const ws = fs.createWriteStream(part, { flags: 'a' })
      try {
        for await (const c0 of Readable.fromWeb(res.body)) {
          restartStall()
          let c = c0
          if (skip) { if (c.length <= skip) { skip -= c.length; continue } c = c.subarray(skip); skip = 0 }
          if (!ws.write(c)) await new Promise(r => ws.once('drain', r))
          say()
        }
      } finally {
        await new Promise(r => ws.end(r))
      }
      if (!ranged && !total) total = have() // no length given: what came is all of it
      if (!ranged && have() < total) throw new Error('cut off')
    } catch (e) { lastErr = e } finally { clearTimeout(timer) }
    if (total && have() > total) { log.warn?.(`[update] download ${name}: ${mb(have())} is more than the ${mb(total)} of the file — from the start again`); fs.rmSync(part, { force: true }); total = 0 } // nonsense: from the start again
    if (lastErr) log.warn?.(`[update] download ${name}: ${lastErr.message} at ${mb(have())}${total ? ` of ${mb(total)}` : ''}${have() > before ? ' (goes on from here)' : ` (try ${failures + 1} of ${tries} with no progress)`}`)
    if (have() > before) failures = 0 // progress: the count starts again
    else if (lastErr) {
      if (lastErr.final) throw new Error(`download failed: ${lastErr.message}`)
      if (++failures >= tries) throw new Error(`download stopped after ${failures} tries with no progress: ${lastErr.message}`)
      await wait(Math.min(60_000, backoff * 2 ** (failures - 1)))
    } else if (++failures >= tries) throw new Error('download stopped: no data')
  }
  say(true)
  const got = await sha256File(part)
  if (got !== want) {
    log.error?.(`[update] download ${name}: ${mb(have())} downloaded but it does not match the signed SHA-256 — thrown away`)
    fs.rmSync(part, { force: true })
    throw new Error('The download does not match Adal\'s signed release (damaged or changed) — not installed')
  }
  fs.renameSync(part, dest)
  log.log?.(`[update] download ${name}: done, ${mb(fs.statSync(dest).size)} (checked)`)
  return dest
}

/** Downloads one piece of the release from Supabase to `dest` (in pieces, resumable) and checks its SHA-256. */
export async function downloadRelease(manifest, dest, opts = {}) {
  const { cloudCall } = await cloud()
  const url = `/storage/v1/object/authenticated/${BUCKET}/${manifest.file}`
  // No limit on the whole request here: rangedDownload's own timers end a piece that does not answer
  // (`timeout`) or stops sending (`stall`). A whole-file answer on a slow line was cut at 180 s.
  return rangedDownload((start, end, signal) => cloudCall(dbRef, 'GET', url, undefined, { raw: true, timeout: 6 * 3600_000, signal, headers: { Range: `bytes=${start}-${end}` } }), dest, manifest.sha256, { size: manifest.size, label: path.basename(manifest.file || dest), ...opts })
}
