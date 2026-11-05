/**
 * restore-adal.mjs — puts a moved Adal Keep back on a new PC. Needs Node only.
 *   node restore-adal.mjs [--to <install folder>] [--project <folder>] [--check-only]
 * Windows: install Adal Keep (Main) from this USB first, then this goes into
 * C:\AdalKeep. The installed .env stays: the old PC's is kept beside it, because
 * its folders are the old PC's. The passphrase comes from ADAL_MOVE_PASS or is asked.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import { spawnSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const win = process.platform === 'win32'
const info = JSON.parse(fs.readFileSync(path.join(here, 'adal-move.json'), 'utf8'))
const parts = Array.from({ length: info.parts }, (_, i) => path.join(here, `adal-move.part${String(i + 1).padStart(3, '0')}`))
for (const p of parts) if (!fs.existsSync(p)) throw new Error(`${path.basename(p)} is missing from the USB`)

const ask = (q) => new Promise(r => { const l = readline.createInterface({ input: process.stdin, output: process.stdout }); l.question(q, a => { l.close(); r(a.trim()) }) })
const pass = process.env.ADAL_MOVE_PASS || await ask('Passphrase: ')
console.log('Unlocking…')
const key = crypto.scryptSync(pass, Buffer.from(info.salt, 'base64'), 32, { N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(info.iv, 'base64'))
d.setAuthTag(Buffer.from(info.tag, 'base64'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-move-'))
const tgz = path.join(work, 'move.tgz')
const sha = crypto.createHash('sha256')
async function* bytes() { for (const p of parts) for await (const c of fs.createReadStream(p, { highWaterMark: 1 << 22 })) { sha.update(c); yield c } }
try {
  await pipeline(Readable.from(bytes()), d, fs.createWriteStream(tgz, { mode: 0o600 }))
} catch (e) {
  fs.rmSync(work, { recursive: true, force: true })
  throw new Error(/auth/i.test(e.message) ? 'Wrong passphrase, or the USB copy is damaged.' : e.message)
}
if (sha.digest('hex') !== info.sha256) throw new Error('The USB copy is damaged.')
console.log('Unlocked and whole.')
if (process.argv.includes('--check-only')) { fs.rmSync(work, { recursive: true, force: true }); process.exit(0) }

const opened = spawnSync('tar', ['-xzf', tgz, '-C', work], { stdio: 'inherit' })
if (opened.status > 1) throw new Error('The bundle could not be opened.')
fs.rmSync(tgz)

const copy = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true }) }
const now = Date.now()

// The developer's side: the project with its history, and the signing keys.
const projectTo = opt('--project') || path.join(os.homedir(), 'Documents', 'Adal_keep')
if (fs.existsSync(path.join(projectTo, '.git'))) throw new Error(`${projectTo} already holds a project: choose another with --project`)
fs.mkdirSync(path.dirname(projectTo), { recursive: true })
copy(path.join(work, 'project'), projectTo)
const keysTo = opt('--keys') || path.join(os.homedir(), '.adal-keep')
copy(path.join(work, 'keys'), keysTo)
copy(path.join(work, 'notes'), path.join(projectTo, 'notes-from-old-pc'))
console.log(`Project: ${projectTo}\nSigning keys: ${keysTo}`)

// The agency's side: into the installed Adal Keep (a Linux PC runs from the project itself).
const install = opt('--to') || (win ? 'C:\\AdalKeep' : null)
if (install) {
  const to = path.join(install, 'backend'), from = path.join(work, 'project', 'adal-keep-backend')
  if (!fs.existsSync(to)) throw new Error(`Adal Keep is not installed in ${install}: install it first. The project is restored already.`)
  for (const ext of ['-wal', '-shm']) fs.rmSync(path.join(to, `data.sqlite${ext}`), { force: true })
  if (fs.existsSync(path.join(to, 'data.sqlite'))) fs.renameSync(path.join(to, 'data.sqlite'), path.join(to, `data.sqlite.before-move-${now}`))
  copy(path.join(from, 'data.sqlite'), path.join(to, 'data.sqlite'))
  // A browser profile's sign-ins are locked to the old system: Windows starts its own.
  if (win) fs.rmSync(path.join(from, 'data', 'browser-profile'), { recursive: true, force: true })
  copy(path.join(from, 'data'), path.join(to, 'data'))
  copy(path.join(from, 'uploads'), path.join(to, 'uploads'))
  copy(path.join(from, '.env'), path.join(to, '.env.from-old-pc'))
  console.log(`Agency data: ${to}`)
}
fs.rmSync(work, { recursive: true, force: true })
console.log('Done.')
