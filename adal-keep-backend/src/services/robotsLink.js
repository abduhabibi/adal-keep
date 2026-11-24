/**
 * Adal Keep ↔ Adal Robots (robots/adal-robots.mjs) on this PC. The robots' tabs live in that program, so what a
 * person does with a run's tab goes there: the live view (its picture, its tab), the person's clicks and keys (the
 * "I'm not a robot" tick), the "needs you" list, Stop and Continue. Over 127.0.0.1:4010 with this PC's token
 * (data/robots-token). Adal Robots not running: the live view says so; Stop and Continue still work here (they
 * only write the queue).
 */
import fs from 'fs'
import path from 'path'
import { robotsInApp } from './robotsInApp.js'

export const ROBOTS_URL = () => `http://127.0.0.1:${Number(process.env.ADAL_ROBOTS_PORT) || 4010}`
// What goes to Adal Robots: [method, path pattern, done here when it is not running?]
export const PASSED = [
  ['GET', /^\/browsers$/, false],
  ['GET', /^\/automations\/attention$/, false],
  ['POST', /^\/automations\/\d+\/captcha$/, false],
  ['POST', /^\/automations\/\d+\/attention\/done$/, false],
  ['GET', /^\/automations\/[\w-]+\/(screen|tab|mirror)$/, false],
  ['POST', /^\/automations\/[\w-]+\/input$/, false],
  ['POST', /^\/automations\/\d+\/(cancel|resume)$/, true],
]
export const passedTo = (method, p) => PASSED.find(([m, re]) => m === method && re.test(p)) || null

let token = null
const tokenOf = () => {
  if (token) return token
  try { token = fs.readFileSync(path.resolve(process.cwd(), 'data', 'robots-token'), 'utf8').trim() } catch { token = null }
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
  try {
    const r = await fetch(ROBOTS_URL() + '/api' + req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json', 'x-adal-robots': t, ...(req.get('accept') ? { accept: req.get('accept') } : {}) },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(req.path.endsWith('/input') ? 15000 : 30000),
    })
    res.status(r.status)
    for (const h of ['content-type', 'cache-control', 'x-frame-at']) { const v = r.headers.get(h); if (v) res.set(h, v) }
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    token = null   // made again when Adal Robots starts again
    if (fallback) return next()
    res.status(503).json({ error: 'Adal Robots is not running on this PC (start it: Adal Robots)', robots: 'off' })
  }
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
export function keepRobotsRunning({ spawnFn = null, platform = process.platform } = {}) {
  if (robotsInApp() || robotsTimer) return false
  if (platform === 'linux' && process.env.ADAL_ROBOTS_SPAWN !== '1') return false   // adal-robots.service
  if (process.env.ADAL_ROBOTS_SPAWN === '0') return false
  const look = async () => {
    if (await robotsAnswer()) return
    try {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('child_process')
      const out = fs.openSync(path.resolve(process.cwd(), 'data', 'robots.log'), 'a')
      const child = spawn(process.execPath, [path.resolve(process.cwd(), 'robots', 'adal-robots.mjs')], {
        cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, ADAL_ROBOTS_IN_APP: '' },
      })
      child.unref?.()
      console.log(`[robots] Adal Robots started (pid ${child.pid}, no window)`)
    } catch (e) { console.warn('[robots] Adal Robots could not start:', e.message) }
  }
  setTimeout(look, 5000).unref?.()
  robotsTimer = setInterval(look, 60000)
  robotsTimer.unref?.()
  return true
}
