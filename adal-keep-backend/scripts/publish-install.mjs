/**
 * publish-install.mjs — install Adal Keep on a PC without the USB.
 *
 *   bash adal-installer/build-installer.sh      (first: the newest installers)
 *   node adal-keep-backend/scripts/publish-install.mjs [days]   (default 3)
 *
 * Puts the two installers, Node.js and the Windows server packages (in parts:
 * a stored file is at most 50 MB) in a private Supabase bucket and prints one
 * line to paste into PowerShell on the new PC. Nothing is built on that PC.
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

// The bundle: the two installers.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-install-'))
const zip = path.join(tmp, 'adal-keep.zip')
execFileSync('zip', ['-q', '-r', zip, '2 - Install Adal Main.exe', '3 - Install Adal Companion.exe'], { cwd: USB })
const bundle = fs.readFileSync(zip)
fs.rmSync(tmp, { recursive: true, force: true })
const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase()
const sha = shaOf(bundle)
const node = fs.readFileSync(path.join(USB, 'deps/node-win-x64.zip'))
const modules = fs.readFileSync(path.join(USB, 'deps/backend-modules.zip'))
const PART = 45 * 1024 * 1024
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
await put('node-win-x64.zip', node, 'application/zip')
const parts = []
for (let i = 0, at = 0; at < modules.length; i++, at += PART) {
  await put(`modules-${i}.bin`, modules.subarray(at, at + PART), 'application/octet-stream')
  parts.push(await link(`modules-${i}.bin`))
}
const script = fs.readFileSync(path.join(ROOT, 'adal-installer/files/web-install.ps1'), 'utf8')
  .replace('__BUNDLE_URL__', await link('adal-keep.zip')).replace('__BUNDLE_SHA__', sha)
  .replace('__NODE_URL__', await link('node-win-x64.zip')).replace('__NODE_SHA__', shaOf(node))
  .replace('__MODULE_URLS__', parts.map(u => `'${u}'`).join(', ')).replace('__MODULES_SHA__', shaOf(modules))
await put('install.ps1', script, 'text/plain')
// Written backwards: a long secret-looking link gets hidden or cut when copied
// from a chat, and then the PC gets a broken link.
const back = [...await link('install.ps1')].reverse().join('')
console.log(`\nPaste into PowerShell on the new PC (works for ${days} days):\n\n$u='${back}'; $c=$u.ToCharArray(); [array]::Reverse($c); irm (-join $c) | iex\n`)
