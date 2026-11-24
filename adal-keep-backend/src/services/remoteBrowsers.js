/**
 * remoteBrowsers.js — a robot started on an Adal Companion works in THAT PC's
 * Adal Browser, on its screen (asked on 2026-11-19: "make the companion do
 * every little thing that the main can").
 *
 * The robots and the data stay on the main PC (the Companion has no database):
 * the main PC drives the Companion's browser over the office network.
 *
 *   • Every minute the Companion (adal-companion.exe, robot.go) tells the main
 *     PC, with its approved key, "my robot browser is on port 47810, token T"
 *     (POST /api/companion/robot-browser). The main PC keeps it in memory,
 *     with the address the call came from.
 *   • A robot started from that Companion (its window opens the main PC's
 *     pages: req.pcAccess is that Companion) carries on_device in its run.
 *   • The worker then connects to http://<companion>:47810/robot/… with the
 *     token (the Companion starts its robot browser if it is closed) and the
 *     run's tab opens there. Not reachable → the run works on the main PC, as
 *     before, and its log says so.
 *   • Files the robot uploads (passport, photo, slip …) are on the main PC:
 *     each is sent to the Companion first (POST /robot/file) and the upload
 *     uses the Companion's copy — every robot's uploads, without changing them.
 */
import fs from 'fs'
import path from 'path'

const SEEN_MS = 3 * 60e3                 // a Companion not heard from for 3 minutes is gone
const devices = new Map()                // pc id → { id, name, ip, port, token, at }
const conns = new Map()                  // pc id → Promise<Browser>
const remote = new WeakMap()             // Browser → device
let patched = false

/** A Companion says where its robot browser is (called with its approved key). */
export function registerDevice(pc, ip, body = {}) {
  if (!pc?.id) return { ok: false }
  const token = String(body.token || '')
  const port = Number(body.port) || 47810
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token) || !ip) return { ok: false, error: 'bad token' }
  const old = devices.get(pc.id)
  if (old && (old.token !== token || old.ip !== ip || old.port !== port)) dropConnection(pc.id)
  const cores = Math.max(1, Math.min(256, Number(body.cores) || 1))
  // How strong it is now (services/sharePower.js picks who does the heavy work).
  const num = (v, lo, hi) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Math.max(lo, Math.min(hi, Number(v)))
  const power = { mem_gb: num(body.mem_gb, 0, 4096), free_gb: num(body.free_gb, 0, 4096), load: num(body.load, 0, 100), battery: body.battery === true }
  // Its internet (adal-companion netprobe.go): how fast and how reliably it reaches the portals.
  const rtt = num(body.net_rtt_ms, 0, 60000)
  const net = rtt == null ? null : { rtt_ms: rtt, mbps: num(body.net_mbps, 0, 10000), ok: num(body.net_ok, 0, 1) }
  // Robots and files go over the office network only, never over the internet.
  const at = String(ip).replace(/^::ffff:/, '')
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(at)
  if (!lan) return { ok: false, error: 'not on the office network' }
  // For the office health page (services/officeHealth.js): its version, Wi-Fi and whether it reaches the other PCs.
  const peersTotal = num(body.peers_total, 0, 500)
  const health = {
    version: body.version ? String(body.version).slice(0, 20) : null,
    wifi: num(body.wifi, 0, 100),
    peers_total: peersTotal,
    peers_ok: peersTotal == null ? null : num(body.peers_ok, 0, peersTotal),
    peers_down: Array.isArray(body.peers_down) ? body.peers_down.slice(0, 20).map(x => String(x).slice(0, 60)) : [],
  }
  devices.set(pc.id, { id: pc.id, name: String(body.name || pc.name || 'Companion').slice(0, 60), ip: at, port, token, cores, ...power, net, ...health, lan, at: Date.now() })
  return { ok: true }
}

/** That Companion's robot browser is there (heard from in the last 3 minutes). */
export function deviceLive(id, now = Date.now()) {
  const d = devices.get(id)
  return !!d && now - d.at < SEEN_MS
}

/**
 * The Companion a request comes from, when its robot browser is there: by its
 * approved key, else by its address (its window and its background program
 * can hold different keys of the same PC). '' for the main PC itself or a phone.
 */
export function deviceForRequest(pc, ip, now = Date.now()) {
  if (pc?.id && deviceLive(pc.id, now)) return pc.id
  const at = String(ip || '').replace(/^::ffff:/, '')
  if (!pc || !at || ['127.0.0.1', '::1'].includes(at)) return ''
  const same = [...devices.values()].filter(d => d.ip === at && now - d.at < SEEN_MS)
  return same.length === 1 ? same[0].id : ''
}

/** A new tab in that Companion's browser, in front, for a person (a move's sign-in). */
export async function tabForPerson(id) {
  const b = await browserForDevice(id)
  const page = await b.newPage()
  await page.bringToFront().catch(() => {})
  return { browser: b, page }
}

/**
 * A run nobody pressed (the scanner queued it) while this PC's Adal Browser is
 * closed: the strongest Companion that is there, and not busy with a run of its
 * own already, does it ("the fast PCs do the most work"). '' when none.
 */
export function freeStrongDevice(busyIds = new Set(), now = Date.now()) {
  if (process.env.ADAL_LAN_ROBOTS !== '1') return ''   // runs stay on this PC (sharePower.lanRobots)
  const list = [...devices.values()].filter(d => now - d.at < SEEN_MS && !busyIds.has(d.id))
  list.sort((a, b) => (b.cores || 1) - (a.cores || 1) || String(a.id).localeCompare(String(b.id)))
  return list[0]?.id || ''
}

/** The Companions' browsers this PC is connected to now (never opens one). */
export async function connectedBrowsers(now = Date.now()) {
  const out = []
  for (const [id, p] of conns) {
    const d = devices.get(id)
    if (!d || now - d.at >= SEEN_MS) continue
    const b = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 3000))]).catch(() => null)
    if (b?.connected) out.push({ id, name: d.name, browser: b })
  }
  return out
}

export function liveDevices(now = Date.now()) {
  return [...devices.values()].filter(d => now - d.at < SEEN_MS).map(({ token, ...d }) => d)
}

export function deviceOf(browser) { return browser ? remote.get(browser) || null : null }
export const isRemote = (browser) => !!deviceOf(browser)

function base(d) { return `http://${d.ip.includes(':') ? `[${d.ip}]` : d.ip}:${d.port}` }

function dropConnection(id) {
  const c = conns.get(id)
  conns.delete(id)
  if (c) c.then(b => b.disconnect().catch(() => {})).catch(() => {})
}

/** The Companion's browser (connected once, kept while it stays connected). */
export async function browserForDevice(id, { quiet = false } = {}) {
  const d = devices.get(id)
  if (!d || !deviceLive(id)) throw new Error('That Adal Companion is not on the office network now')
  const have = conns.get(id)
  if (have) {
    const b = await have.catch(() => null)
    if (b?.connected) return b
    conns.delete(id)
  }
  const p = (async () => {
    // quiet: opened for another PC's work — it starts minimized there, never over the person's work.
    const r = await fetch(`${base(d)}/robot/json/version${quiet ? '?quiet=1' : ''}`, { headers: { 'x-adal-robot': d.token }, signal: AbortSignal.timeout(45000) })
    if (!r.ok) throw new Error(`the Companion's browser did not open (${r.status})`)
    const v = await r.json()
    if (!v.webSocketDebuggerUrl) throw new Error('the Companion gave no browser address')
    const puppeteer = (await import('puppeteer-core')).default
    const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, headers: { 'x-adal-robot': d.token }, defaultViewport: null, protocolTimeout: 180000 })
    remote.set(b, d)
    b.on('disconnected', () => { if (conns.get(id) === p) conns.delete(id) })
    await patchUploads(b)
    console.log(`[remote-browser] connected to ${d.name}'s Adal Browser (${d.ip})`)
    return b
  })()
  conns.set(id, p)
  try { return await p } catch (e) { conns.delete(id); throw e }
}

/** Send one file to the Companion; its path there. */
export async function sendFile(d, localPath) {
  const name = path.basename(localPath).replace(/[^\w.\-]+/g, '_').slice(-120) || 'file'
  const body = await fs.promises.readFile(localPath)
  const r = await fetch(`${base(d)}/robot/file?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'x-adal-robot': d.token, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(120000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.path) throw new Error(`the file did not reach the Companion (${j.error || r.status})`)
  return j.path
}

/**
 * Every upload (ElementHandle.uploadFile; a file chooser's accept() uses it
 * too) in a Companion's browser sends the files there first. Patched once, on
 * the class of a real handle; uploads in the main PC's browser are unchanged.
 */
async function patchUploads(browser) {
  if (patched) return
  let page = null, own = false
  try {
    page = (await browser.pages())[0]
    if (!page) { page = await browser.newPage(); own = true }
    const h = await page.evaluateHandle(() => document.documentElement)
    const proto = Object.getPrototypeOf(h)
    await h.dispose().catch(() => {})
    patchProto(proto)
  } catch (e) {
    console.warn('[remote-browser] uploads not ready:', e.message)
  } finally {
    if (own) await page.close().catch(() => {})
  }
}

/** (exported for the test) */
export function patchProto(proto) {
  if (patched || !proto || typeof proto.uploadFile !== 'function') return
  const original = proto.uploadFile
  proto.uploadFile = async function (...paths) {
    let d = null
    try { d = deviceOf(this.frame.page().browser()) } catch {}
    if (!d) return original.apply(this, paths)
    const there = []
    for (const p of paths) there.push(await sendFile(d, p))
    return original.apply(this, there)
  }
  patched = true
}

export function _resetForTest() { devices.clear(); conns.clear(); patched = false }
export const _rememberForTest = (browser, d) => remote.set(browser, d)
