/**
 * claimBridge.js — Umar's run claims (runClaims.js: one run per girl and site across the agency's PCs) live in Adal
 * Keep's server, where the PC copying is; the runs start in Adal Robots, a program of its own. So:
 *  - the server answers POST /api/run-claims/claim and /release from this PC only (127.0.0.1, the robots' token);
 *  - Adal Robots asks it just before a run starts and tells it when the run ends (worker.js).
 * The server does not answer in 5 s: the run goes on, as before (no run lost to a claim error). A robot in the app
 * itself (ADAL_ROBOTS_IN_APP=1, the server): runClaims directly. Off: ADAL_ROBOTS_EVERYWHERE=0 (runClaims grants all).
 */
import fs from 'fs'
import path from 'path'

const dataDir = () => process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data')
const token = () => { try { return fs.readFileSync(path.join(dataDir(), 'robots-token'), 'utf8').trim() } catch { return '' } }
const serverURL = () => process.env.ADAL_SERVER_URL || `http://127.0.0.1:${Number(process.env.PORT) || 4000}`
const inServer = () => process.env.ADAL_ROBOT_PROCESS !== '1'
const slim = (job) => ({ id: job.id, profile_id: job.profile_id, workflow_id: job.workflow_id })

async function ask(op, body, fetchFn = fetch) {
  const r = await fetchFn(`${serverURL()}/api/run-claims/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-robots': token() }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`Adal Keep answered ${r.status}`)
  return r.json()
}

/** May this run start here? { ok, via } | { ok: false, by, why }. */
export async function claimForRun(db, job, { fetchFn } = {}) {
  try {
    if (inServer()) return await (await import('./runClaims.js')).claimRun(db, job)
    return await ask('claim', { job: slim(job) }, fetchFn)
  } catch (e) { return { ok: true, via: 'alone', error: e.message } }
}

/** The run ended (any way). Never throws. */
export async function releaseForRun(db, job, result = 'done', { fetchFn } = {}) {
  try {
    if (inServer()) return await (await import('./runClaims.js')).releaseRun(db, job, result)
    await ask('release', { job: slim(job), result }, fetchFn)
  } catch {}
}

/** The server's side (main.js). Only this PC, only with the robots' token. */
export function claimRoutes(express) {
  const router = express.Router()
  const local = (req, res, next) => {
    const ip = String(req.socket?.remoteAddress || '')
    if (!/^(127\.|::1$|::ffff:127\.)/.test(ip) || !token() || req.get('x-adal-robots') !== token()) return res.status(403).json({ error: 'Adal Robots of this PC only' })
    next()
  }
  router.post('/run-claims/claim', local, async (req, res) => {
    try { res.json(await (await import('./runClaims.js')).claimRun(req.app.locals.db, req.body?.job || {})) } catch (e) { res.json({ ok: true, via: 'alone', error: e.message }) }
  })
  router.post('/run-claims/release', local, async (req, res) => {
    try { await (await import('./runClaims.js')).releaseRun(req.app.locals.db, req.body?.job || {}, req.body?.result || 'done'); res.json({ ok: true }) } catch (e) { res.json({ ok: false, error: e.message }) }
  })
  return router
}
