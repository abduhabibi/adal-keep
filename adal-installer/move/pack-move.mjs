/**
 * pack-move.mjs — everything of this PC's Adal Keep into one locked bundle, for
 * moving to a new PC:   node pack-move.mjs <folder on the USB>   (ADAL_MOVE_PASS set)
 *
 * The project folder (database, documents, WhatsApp, .env, git history), the
 * signing keys of ~/.adal-keep and the notes. Stop the server first, so the
 * database and browser profiles are at rest.
 *
 * Locked because it holds the update signing key: whoever has it could sign an
 * update for every agency PC. Split because a USB in FAT32 takes 4 GB per file.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const out = process.argv[2]
const pass = process.env.ADAL_MOVE_PASS
if (!out || !pass) throw new Error('usage: ADAL_MOVE_PASS=… node pack-move.mjs <folder>')
const PART = 1800 * 1024 * 1024
const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..', '..')
const home = os.homedir()
const rel = (p) => path.relative('/', p)
const notes = path.join(home, '.claude/projects', project.replace(/[/_ ]/g, '-'), 'memory')

const skip = ['node_modules', '.venv', 'dist', 'Adal Keep USB', 'AdalKeep-Installer', 'stage', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'adblock_cache', 'component_crx_cache', 'extensions_crx_cache', 'BrowserMetrics*', 'Singleton*', 'admin-window', 'app-window',
  '.gradle', 'adal-phone/android/app/build', 'keep-app', '*.sqlite-wal', '*.sqlite-shm']
const args = ['-czf', '-', ...skip.map(s => `--exclude=${s}`),
  `--transform=s,^${rel(project)},project,`, `--transform=s,^${rel(path.join(home, '.adal-keep'))},keys,`, `--transform=s,^${rel(notes)},notes,`,
  '-C', '/', rel(project), rel(path.join(home, '.adal-keep'))]
if (fs.existsSync(notes)) args.push(rel(notes))

fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (/^adal-move\.(part\d+|json)$/.test(f)) fs.rmSync(path.join(out, f))
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
const key = crypto.scryptSync(pass, salt, 32, { N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const sha = crypto.createHash('sha256')

let n = 0, size = 0, file = null, total = 0
const openPart = () => { n++; size = 0; file = fs.openSync(path.join(out, `adal-move.part${String(n).padStart(3, '0')}`), 'w') }
const write = (buf) => {
  sha.update(buf); total += buf.length
  for (let at = 0; at < buf.length;) {
    if (file === null || size >= PART) { if (file !== null) fs.closeSync(file); openPart() }
    const take = Math.min(buf.length - at, PART - size)
    fs.writeSync(file, buf, at, take); at += take; size += take
  }
}
const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'inherit'] })
for await (const chunk of tar.stdout) write(cipher.update(chunk))
const code = await new Promise(r => tar.on('close', r))
if (code > 1) throw new Error(`tar stopped with ${code}`)   // 1: a file changed while read
write(cipher.final())
fs.closeSync(file)
fs.writeFileSync(path.join(out, 'adal-move.json'), JSON.stringify({
  made: new Date().toISOString(), parts: n, bytes: total, sha256: sha.digest('hex'),
  salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
}, null, 2))
console.log(`${n} part(s), ${(total / 1048576).toFixed(0)} MB`)
