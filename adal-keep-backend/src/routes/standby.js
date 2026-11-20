/**
 * /api/companion — every Adal Companion is a full Adal Keep in waiting
 * (asked on 2026-11-20: "the only difference between main PC and companion PC
 * is just the buttons"). adal-companion.exe (standby.go):
 *
 *   GET  /companion/server-bundle   the server itself (Node and the backend,
 *                                   never the data): kept on the Companion, it
 *                                   stands in for this PC when it is away.
 *                                   ETag: this PC's version; 304 when it has it.
 *   POST /companion/merge-back      {token, since, port} — a Companion stood in
 *                                   while this PC was away: this PC reads what
 *                                   was done there since (its own address, the
 *                                   token it was given) and takes it in
 *                                   (services/branchMerge.js, newest change wins).
 *   GET  /companion/merge-back      that merge's progress.
 *
 * Only an approved Adal Companion (networkGate: req.pcAccess), straight on the
 * network — never through the online link.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { ipOf } from '../services/networkGate.js'
import { startMerge, job } from '../services/branchMerge.js'
import os from 'os'
import { lock } from '../services/telegramBackup.js'
import { getSecret as getSecretSync } from '../services/secretStore.js'

const router = express.Router()
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALL = path.join(BACKEND, '..')

const companionOnly = (req, res, next) => {
  if (!req.pcAccess || req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Only an approved Adal Companion, on the office network' })
  next()
}

/** What the bundle holds, and leaves out (the data stays on each PC). */
export const BUNDLE_EXCLUDES = [
  'backend/data', 'backend/uploads', 'backend/.env', 'backend/logs', 'backend/tests', 'backend/.env.local',
  'backend/node_modules.before-*', 'backend/before-*', 'backend/*.sqlite*', 'backend/data.sqlite*',
  '*.log', '.previous-version',
]

// Windows' own tar (never another one on the PATH, such as Git's).
export const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

export function versionOf(root = INSTALL) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.adal-version.json'), 'utf8'))?.sha || '' } catch { return '' }
}

/** A folder holding backend/.env.locked (the settings locked with the backup key), or null. */
export function lockedSettingsDir({ envFile = path.join(BACKEND, '.env'), password = null } = {}) {
  try {
    if (!fs.existsSync(envFile)) return null
    const pw = password || getSecretSync('backup_password')
    if (!pw) return null
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-env-'))
    fs.mkdirSync(path.join(dir, 'backend'))
    fs.writeFileSync(path.join(dir, 'backend', '.env.locked'), lock(fs.readFileSync(envFile), pw))
    return dir
  } catch (e) { console.warn('[standby] settings not locked:', e.message); return null }
}

router.get('/companion/server-bundle', companionOnly, (req, res) => {
  const node = path.join(INSTALL, 'runtime', 'node.exe')
  if (!fs.existsSync(node) || !fs.existsSync(path.join(BACKEND, 'node_modules'))) {
    return res.status(404).json({ error: 'This PC is not an installed main PC (no runtime here)' })
  }
  const sha = versionOf() || 'dev'
  res.set('ETag', `"${sha}"`)
  if (String(req.headers['if-none-match'] || '').replace(/"/g, '') === sha) return res.status(304).end()
  res.set('Content-Type', 'application/gzip')
  res.set('X-Adal-Version', sha)
  // (Windows: -L, a folder that is only a link is packed as the folder itself.)
  const args = [...(process.platform === 'win32' ? ['-L'] : []), '-czf', '-', '-C', INSTALL, ...BUNDLE_EXCLUDES.flatMap(x => ['--exclude', x]), 'runtime', 'backend']
  // Its pages too (the updater's place, or an older install's).
  for (const p of ['adal-keep-frontend/dist', 'frontend']) if (fs.existsSync(path.join(INSTALL, p, 'index.html'))) args.push(p)
  if (fs.existsSync(path.join(INSTALL, '.adal-version.json'))) args.push('.adal-version.json')
  // The server's settings (the licence key, the AI keys) never travel readable:
  // locked with the agency's backup key (only a PC that has it opens them).
  const tmp = lockedSettingsDir()
  if (tmp) args.push('-C', tmp, 'backend/.env.locked')
  const tar = spawn(TAR, args, { windowsHide: true })
  tar.on('close', () => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })
  tar.stdout.pipe(res)
  tar.stderr.on('data', () => {})
  tar.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.destroy() })
  req.on('close', () => { if (tar.exitCode === null) tar.kill() })
})

router.post('/companion/merge-back', companionOnly, (req, res) => {
  const token = String(req.body?.token || '')
  const since = String(req.body?.since || '')
  const port = Number(req.body?.port) || 4000
  if (token.length < 24 || Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'token and since are needed' })
  // Its own address (never one it names): the PC that called is the one read.
  const ip = ipOf(req)
  const source = `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`
  try {
    res.json(startMerge(req.app.locals.db, source, { headers: { 'x-adal-merge': token }, since }))
  } catch (e) {
    res.status(409).json({ error: e.message, ...job })
  }
})
router.get('/companion/merge-back', companionOnly, (req, res) => res.json(job))

export default router
