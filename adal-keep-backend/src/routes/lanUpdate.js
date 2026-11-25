/**
 * /api/companion/lan — the signed release this main PC runs, for its own Companions (services/lanServe.js).
 *
 *   GET /companion/lan/latest       { manifest, signature }; 304 when the Companion has it (ETag: its sha)
 *   GET /companion/lan/file/<sha>   one file the signed manifest names (Range)
 *   GET /companion/lan/settings     the server's settings, locked with the agency's backup key (a first server)
 *
 * Only an approved Adal Companion, straight on the office network (as routes/standby.js). Nothing is
 * taken here: no route of this file writes.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { releaseHere, fileHere, lanUpdatesOn } from '../services/lanServe.js'
import { lockedSettingsDir } from './standby.js'

const router = express.Router()
const companionOnly = (req, res, next) => {
  if (!req.pcAccess || req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Only an approved Adal Companion, on the office network' })
  if (!lanUpdatesOn()) return res.status(404).json({ error: 'off' })
  next()
}
const edge = (fn) => async (req, res) => { try { await fn(req, res) } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.destroy() } }

router.get('/companion/lan/latest', companionOnly, edge(async (req, res) => {
  const env = releaseHere()
  if (!env) return res.status(404).json({ error: 'This PC runs no signed release it can hand on' })
  const tag = `"${env.manifest.sha}"`
  res.set('ETag', tag)
  if (req.headers['if-none-match'] === tag) return res.status(304).end()
  const body = JSON.stringify(env)
  res.type('json')
  if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return res.send(body)
  res.set('Content-Encoding', 'gzip').send(await new Promise((ok, no) => zlib.gzip(body, (e, b) => e ? no(e) : ok(b))))
}))
router.get('/companion/lan/file/:sha', companionOnly, edge(async (req, res) => {
  const f = await fileHere(String(req.params.sha))
  if (!f) return res.status(404).json({ error: 'not in the signed release this PC runs' })
  res.set('Content-Type', 'application/octet-stream').set('Cache-Control', 'no-store')
  res.sendFile(path.resolve(f.file), { dotfiles: 'allow', acceptRanges: true, lastModified: false, etag: false }, (e) => { if (e && !res.headersSent) res.status(e.status || 500).end() })
}))
router.get('/companion/lan/settings', companionOnly, edge(async (req, res) => {
  const dir = lockedSettingsDir()
  if (!dir) return res.status(404).end()
  const b = fs.readFileSync(path.join(dir, 'backend', '.env.locked'))
  fs.rmSync(dir, { recursive: true, force: true })
  res.set('Content-Type', 'application/octet-stream').send(b)
}))
export default router
