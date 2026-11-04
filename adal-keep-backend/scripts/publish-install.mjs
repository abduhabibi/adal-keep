/**
 * publish-install.mjs — install Adal Keep on a PC without the USB.
 *
 *   bash adal-installer/build-installer.sh      (first: the newest installers)
 *   node adal-keep-backend/scripts/publish-install.mjs [days]   (default 3)
 *
 * Puts the two installers and PREPARE's script in a private Supabase bucket
 * and prints one line to paste into PowerShell on the new PC.
 *
 * The installers hold ADAL_LICENSE_KEY and the Supabase and AI keys, so they
 * never go on GitHub or in "adal-updates" (every PC and phone can read that).
 * This bucket has no read rule: only the admin key and these expiring links
 * reach it. Anyone holding the link can download until it expires.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USB = path.join(ROOT, 'Adal Keep USB')
const BUCKET = 'adal-install'
const days = Number(process.argv[2]) || 3
const { SUPABASE_URL: URL, SUPABASE_SERVICE_KEY: KEY } = dotenv.parse(fs.readFileSync(path.join(ROOT, 'adal-admin/.env')))
if (!URL || !KEY) throw new Error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// The bundle: installers + PREPARE (it fetches Node, the packages and Brave on the PC).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-install-'))
const zip = path.join(tmp, 'adal-keep.zip')
execFileSync('zip', ['-q', '-r', zip, '2 - Install Adal Main.exe', '3 - Install Adal Companion.exe', 'deps/prepare-deps.ps1', 'deps/source'], { cwd: USB })
const bundle = fs.readFileSync(zip)
fs.rmSync(tmp, { recursive: true, force: true })
const sha = crypto.createHash('sha256').update(bundle).digest('hex').toUpperCase()
console.log(`bundle: ${(bundle.length / 1048576).toFixed(1)} MB`)

const made = await fetch(`${URL}/storage/v1/bucket`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) })
if (!made.ok && !/already exists|Duplicate/i.test(await made.text())) throw new Error(`bucket: ${made.status}`)
const put = async (name, body, type) => {
  const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${name}`, { method: 'POST', headers: { ...auth, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'no-cache' }, body })
  if (!r.ok) throw new Error(`upload ${name}: ${r.status} ${(await r.text()).slice(0, 200)}`)
}
const link = async (name) => {
  const r = await fetch(`${URL}/storage/v1/object/sign/${BUCKET}/${name}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: days * 86400 }) })
  if (!r.ok) throw new Error(`link ${name}: ${r.status}`)
  const { signedURL } = await r.json()
  return `${URL}/storage/v1${signedURL.startsWith('/') ? '' : '/'}${signedURL}`
}

await put('adal-keep.zip', bundle, 'application/zip')
const script = fs.readFileSync(path.join(ROOT, 'adal-installer/files/web-install.ps1'), 'utf8')
  .replace('__BUNDLE_URL__', await link('adal-keep.zip')).replace('__BUNDLE_SHA__', sha)
await put('install.ps1', script, 'text/plain')
console.log(`\nPaste into PowerShell on the new PC (works for ${days} days):\n\nirm '${await link('install.ps1')}' | iex\n`)
