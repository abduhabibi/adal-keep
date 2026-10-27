/**
 * mainPC.js — which PC is the agency's main PC.
 *
 * Every agency has ONE main PC: it holds the database and every file, and
 * every other PC (the other branch, a laptop at home, a phone) opens that
 * PC's Adal Keep. A PC with Adal Keep installed is the main PC until someone
 * on it chooses "another PC is the main PC" in Settings. Then this PC
 * follows that one: the launcher opens the main PC's page, the Companion
 * sends its scans there, and this PC stops answering "where is Adal Keep?"
 * on the network and runs no automations of its own.
 *
 * The choice lives in data/main-pc.json so the Windows launcher reads it too:
 *   { "main_url": "" }                          → this PC is the main PC
 *   { "main_url": "http://100.101.102.103:4000" } → that PC is
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { getLanAddresses } from './discovery.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = path.join(BACKEND, 'data')
const FILE = path.join(DATA, 'main-pc.json')
const INSTALL = path.join(BACKEND, '..') // backend/ sits inside the install folder

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch { return {} }
}
function writeFile(obj) {
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2))
}

/**
 * This PC's number for the phone app: 5 digits, made once and kept. A phone
 * on the same Wi-Fi types it once to pair with this PC.
 */
export function pcNumber() {
  const f = readFile()
  if (/^\d{5}$/.test(f.pc_number || '')) return f.pc_number
  f.pc_number = String(crypto.randomInt(10000, 100000))
  writeFile(f)
  return f.pc_number
}

/** A random id for this install, so a PC can never choose itself as main. */
export function instanceId() {
  const f = readFile()
  if (f.instance) return f.instance
  f.instance = crypto.randomBytes(8).toString('hex')
  writeFile(f)
  return f.instance
}

/** '' when this PC is the main PC, else the main PC's address. */
export function mainURL() {
  return String(readFile().main_url || '').trim().replace(/\/+$/, '')
}
export const isFollower = () => !!mainURL()

/** Tidy what a person typed: "100.1.2.3" → "http://100.1.2.3:4000". */
export function normalizeURL(input) {
  let u = String(input || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  const parsed = new URL(u) // throws on nonsense
  if (parsed.protocol === 'http:' && !parsed.port) parsed.port = '4000'
  return parsed.origin
}

/**
 * Check the address answers as an Adal Keep main PC (not this PC, not a
 * follower). Returns the address to save.
 */
export async function checkMainPC(input) {
  const url = normalizeURL(input)
  if (!url) throw new Error('Type the main PC address.')
  let info
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000) })
    info = await r.json()
  } catch {
    throw new Error(`No Adal Keep answers at ${url}. Is that PC on, and is Tailscale (or the office network) connected on both PCs?`)
  }
  if (info?.status !== 'ok') throw new Error(`${url} is not Adal Keep.`)
  if (info.instance && info.instance === instanceId()) throw new Error('That address is this PC itself.')
  if (info.role === 'follower') throw new Error(`${url} itself follows another main PC (${info.main_url}). Use that address instead.`)
  return url
}

/** Save the choice ('' = this PC is the main PC) and point the Companion at it. */
export function setMainURL(url) {
  const f = readFile()
  f.main_url = url || ''
  f.changed_at = new Date().toISOString()
  writeFile(f)
  pointCompanion(url || 'http://localhost:4000')
}

// The Companion on this PC sends scans to whatever companion.conf names.
function pointCompanion(url) {
  const exe = path.join(INSTALL, process.platform === 'win32' ? 'adal-companion.exe' : 'adal-companion')
  if (!fs.existsSync(exe)) return // developer checkout: no Companion here
  fs.writeFileSync(path.join(INSTALL, 'companion.conf'),
    '# Written by Adal Keep (Settings → Main PC).\n' + `ADAL_HOST_URL=${url}\n`)
  if (process.platform === 'win32') {
    // Restart it so it reads the new address now.
    execFile('taskkill', ['/F', '/IM', 'adal-companion.exe'], { windowsHide: true }, () => {
      import('child_process').then(({ spawn }) => {
        try { spawn(exe, [], { cwd: INSTALL, detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch {}
      })
    })
  }
}

// ── Tailscale: this PC's private-link address ────────────────────────────────

const TS_EXE = process.platform === 'win32'
  ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale']
  : ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale']

function runTailscale(args, timeout = 6000) {
  return new Promise((resolve) => {
    const tryAt = (i) => {
      if (i >= TS_EXE.length) return resolve({ ok: false, error: 'Tailscale is not installed on this PC.' })
      execFile(TS_EXE[i], args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return tryAt(i + 1)
        if (err) return resolve({ ok: false, error: String(stderr || err.message).trim().slice(0, 400) })
        resolve({ ok: true, out: String(stdout) })
      })
    }
    tryAt(0)
  })
}

/** { installed, connected, ip, name, https } for this PC. */
export async function tailscaleInfo() {
  const r = await runTailscale(['status', '--json'])
  if (!r.ok) {
    // Not installed (or no CLI): an address in 100.64.0.0/10 still means it runs.
    const ip = getLanAddresses().find(a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a))
    return { installed: !!ip, connected: !!ip, ip: ip || null, name: null, https: null, error: ip ? null : r.error }
  }
  try {
    const s = JSON.parse(r.out)
    const self = s.Self || {}
    const ip = (self.TailscaleIPs || []).find(a => a.includes('.')) || null
    const name = String(self.DNSName || '').replace(/\.$/, '') || null
    const connected = s.BackendState === 'Running'
    return { installed: true, connected, ip, name, https: name ? `https://${name}` : null, state: s.BackendState }
  } catch {
    return { installed: true, connected: false, ip: null, name: null, https: null }
  }
}

/**
 * Phones need https to install the app and record voice. `tailscale serve`
 * gives this PC a real https address inside the private link only.
 */
export async function turnOnHttps(port = Number(process.env.PORT) || 4000) {
  const r = await runTailscale(['serve', '--bg', String(port)], 30000)
  if (!r.ok) {
    if (/HTTPS|cert/i.test(r.error)) {
      throw new Error('Turn on "HTTPS Certificates" first: login.tailscale.com → DNS → HTTPS Certificates → Enable. Then press this again.')
    }
    if (/access denied|operator|permission/i.test(r.error)) {
      throw new Error('Tailscale needs an administrator for this. Right-click the Tailscale icon → run as administrator, or ask IT. Message: ' + r.error)
    }
    throw new Error(r.error)
  }
  return tailscaleInfo()
}

/** Everything the Settings card shows about this PC. */
export async function describe() {
  const port = Number(process.env.PORT) || 4000
  return {
    role: isFollower() ? 'follower' : 'main',
    pc_number: isFollower() ? null : pcNumber(),
    main_url: mainURL(),
    instance: instanceId(),
    port,
    lan: getLanAddresses().filter(a => !a.startsWith('100.')).map(a => `http://${a}:${port}`),
    tailscale: await tailscaleInfo(),
  }
}
