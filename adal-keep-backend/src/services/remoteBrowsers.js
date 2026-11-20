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
  devices.set(pc.id, { id: pc.id, name: String(body.name || pc.name || 'Companion').slice(0, 60), ip: String(ip).replace(/^::ffff:/, ''), port, token, at: Date.now() })
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
export async function browserForDevice(id) {
  const d = devices.get(id)
  if (!d || !deviceLive(id)) throw new Error('That Adal Companion is not on the office network now')
  const have = conns.get(id)
  if (have) {
    const b = await have.catch(() => null)
    if (b?.connected) return b
    conns.delete(id)
  }
  const p = (async () => {
    const r = await fetch(`${base(d)}/robot/json/version`, { headers: { 'x-adal-robot': d.token }, signal: AbortSignal.timeout(45000) })
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
