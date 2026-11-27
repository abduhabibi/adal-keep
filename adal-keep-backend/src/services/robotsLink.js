/**
 * Adal Keep ↔ Adal Robots (robots/adal-robots.mjs) on this PC. The robots' tabs live in that program, so what a
 * person does with a run's tab goes there: the live view (its picture, its tab), the person's clicks and keys (the
 * "I'm not a robot" tick), the "needs you" list, Stop and Continue. Over 127.0.0.1:4010 with this PC's token
 * (data/robots-token). Adal Robots not running: the live view says so; Stop and Continue still work here (they
 * only write the queue).
 */
import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'
import { robotsInApp } from './robotsInApp.js'

export const ROBOTS_URL = () => `http://127.0.0.1:${Number(process.env.ADAL_ROBOTS_PORT) || 4010}`
// What goes to Adal Robots: [method, path pattern, done here when it is not running?]
export const PASSED = [
  ['GET', /^\/browsers$/, false],
  ['GET', /^\/automations\/attention$/, false],
  ['POST', /^\/automations\/\d+\/captcha$/, false],
  ['POST', /^\/automations\/\d+\/attention\/done$/, false],
  ['GET', /^\/automations\/[\w-]+\/(screen|stream|live|tab|mirror)$/, false],
  ['POST', /^\/automations\/[\w-]+\/input$/, false],
  ['POST', /^\/automations\/\d+\/(cancel|resume)$/, true],
  ['GET', /^\/automations\/watch-robots$/, false],
  ['POST', /^\/automations\/watch-robots$/, false],
]
export const passedTo = (method, p) => PASSED.find(([m, re]) => m === method && re.test(p)) || null

let token = null
const tokenOf = () => {
  if (token) return token
  try { token = fs.readFileSync(path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'robots-token'), 'utf8').trim() } catch { token = null }
  return token
}

/** Express middleware (mounted on /api) — only when the robots are not in the app. */
export async function robotsLink(req, res, next) {
  if (robotsInApp()) return next()
  const rule = passedTo(req.method, req.path)
  if (!rule) return next()
  const t = tokenOf()
  const fallback = rule[2]
  if (!t) return fallback ? next() : res.status(503).json({ error: 'Adal Robots is not running on this PC', robots: 'off' })
  const off = () => {
    token = null   // made again when Adal Robots starts again
    if (fallback && !res.headersSent) return next()
    if (!res.headersSent) res.status(503).json({ error: 'Adal Robots is not running on this PC (start it: Adal Robots)', robots: 'off' })
    else res.end()
  }
  // Passed on as it comes, piece by piece (2026-11-24: the live view's pictures are one endless stream — read whole
  // it never came, and the view stayed on "Opening the robot's browser…").
  const body = req.method === 'GET' ? null : JSON.stringify(req.body || {})
  const u = new URL(ROBOTS_URL() + '/api' + req.url)
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, agent: false,
    headers: { 'x-adal-robots': t, ...(req.headers['x-adal-pc'] ? { 'x-adal-pc': '1', ...(req.headers['x-adal-flush'] ? { 'x-adal-flush': '1' } : {}) } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (r) => {
    up.setTimeout(0)
    res.status(r.statusCode)
    for (const h of ['content-type', 'cache-control', 'x-frame-at', 'x-accel-buffering', 'x-adal-live']) if (r.headers[h]) res.set(h, r.headers[h])
    res.flushHeaders?.()
    res.socket?.setNoDelay?.(true)
    r.on('error', () => res.end())
    r.pipe(res)
  })
  // Nothing at all in 30 s (a stream's headers come at once): it is stuck or off.
  // (Stop and Continue only write the queue: not answered in 4 s — Adal Robots is starting — done here.)
  up.setTimeout(fallback ? 4000 : 30000, () => up.destroy(new Error('no answer')))
  up.on('error', off)
  res.on('close', () => up.destroy())   // the viewer closed: the robot stops sending
  up.end(body || undefined)
}

/**
 * Adal Robots kept running on the main PC (Windows: no window, ever; it starts with Adal Keep, which starts with
 * the PC). A program of its own, detached: it goes on when Adal Keep restarts, and Adal Keep goes on when it is
 * stuck. Looked at every minute; started again when it does not answer. Linux: its own systemd unit
 * (adal-robots.service) does this — Adal Keep starts nothing there.
 */
let robotsTimer = null
export async function robotsAnswer(ms = 3000) {
  try { const r = await fetch(ROBOTS_URL() + '/health', { signal: AbortSignal.timeout(ms) }); return r.ok } catch { return false }
}
/** Something listens on its port (it may be too busy to answer). */
export const robotsThere = (ms = 2000) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: Number(process.env.ADAL_ROBOTS_PORT) || 4010 })
  const end = (v) => { s.destroy(); resolve(v) }
  s.setTimeout(ms, () => end(false)); s.once('connect', () => end(true)); s.once('error', () => end(false))
})
export function keepRobotsRunning({ spawnFn = null, platform = process.platform } = {}) {
  if (robotsInApp() || robotsTimer) return false
  if (platform === 'linux' && process.env.ADAL_ROBOTS_SPAWN !== '1') return false   // adal-robots.service
  if (process.env.ADAL_ROBOTS_SPAWN === '0') return false
  let child = null, spawnedAt = 0
  const look = async () => {
    if (await robotsAnswer()) return
    // Started a moment ago and still starting (a slow PC), or one is there and only slow: never a second one
    // (2026-11-25, Main: "another Adal Robots already works — this one stops"). One that listens but answers
    // nothing for 3 minutes is let go on too: it alone holds the port; its own start-up ends a second one.
    if (child && child.exitCode === null && child.signalCode == null && Date.now() - spawnedAt < 120000) return
    if (await robotsThere()) { if (await robotsAnswer(20000)) return; if (Date.now() - spawnedAt < 180000) return }
    try {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('child_process')
      const out = fs.openSync(path.resolve(process.cwd(), 'data', 'robots.log'), 'a')
      child = spawn(process.execPath, [path.resolve(process.cwd(), 'robots', 'adal-robots.mjs')], {
        cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, ADAL_ROBOTS_IN_APP: '' },
      })
      spawnedAt = Date.now()
      child.unref?.()
      console.log(`[robots] Adal Robots started (pid ${child.pid}, no window)`)
    } catch (e) { console.warn('[robots] Adal Robots could not start:', e.message) }
  }
  setTimeout(look, 5000).unref?.()
  robotsTimer = setInterval(look, 60000)
  robotsTimer.unref?.()
  return true
}
