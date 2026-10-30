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
import { Readable } from 'stream'

export const BUCKET = 'adal-updates'
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAimpnKnJzVGiLNH27Lkf4b2aCJoLOpL1fQuqF/gM1HTo=
-----END PUBLIC KEY-----`

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
  try { return crypto.verify(null, Buffer.from(canonical(manifest)), PUBLIC_KEY, Buffer.from(String(signature || ''), 'base64')) } catch { return false }
}

let dbRef = null
export const setUpdateDb = (db) => { if (db) dbRef = db }

async function cloud() {
  const c = await import('./chatCloud.js')
  if (!c.chatConfigured()) throw new Error('Supabase is not set up on this PC')
  return c
}

/** The newest signed release, or an error that says why not. */
export async function latestRelease(channel = 'release') {
  const { cloudCall } = await cloud()
  const res = await cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${channel}/latest.json`, undefined, { raw: true, headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) throw new Error(`Supabase updates answered ${res.status}${res.status === 400 || res.status === 404 ? ' (nothing published yet, or updates.sql not run)' : ''}`)
  const { manifest, signature } = await res.json()
  if (!manifest?.sha || !verifyManifest(manifest, signature)) throw new Error('The published update is not signed by Adal — not installed')
  return manifest
}

/** Downloads the release's bundle to `dest` and checks its SHA-256. */
export async function downloadRelease(manifest, dest) {
  const { cloudCall } = await cloud()
  const res = await cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${manifest.file}`, undefined, { raw: true })
  if (!res.ok) throw new Error(`Download failed: Supabase answered ${res.status}`)
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest)
    const rs = Readable.fromWeb(res.body)
    rs.on('data', (c) => hash.update(c))
    rs.pipe(ws).on('finish', resolve).on('error', reject)
    rs.on('error', reject)
  })
  const got = hash.digest('hex')
  if (got !== manifest.sha256) throw new Error('The download does not match Adal\'s signed release (damaged or changed) — not installed')
  return dest
}
