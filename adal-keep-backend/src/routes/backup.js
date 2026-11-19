/**
 * /api/backup — the Telegram off-site backup (Settings → Backup).
 * Setting it up and restoring work only on the main PC itself. "Back up now"
 * (and its progress) works from any PC of the agency — a Companion on the LAN,
 * a phone or Companion through the online copy — and never makes a second run:
 * one already going is followed by one more, by itself.
 */
import express from 'express'
import multer from 'multer'
import { getConfig, saveConfig, testConnection, findChats, botInfo, runBackup, progress, restoreFrom, newestBackup, backupSoon } from '../services/telegramBackup.js'
import { onThisPC } from './trash.js'
import { isFollower, mainURL, mainKey } from '../services/mainPC.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
const here = (req, res, next) => (onThisPC(req) ? next() : res.status(403).json({ error: 'Backups are set up on the main PC itself.' }))
const fail = (res, e) => res.status(400).json({ error: e.message })

// A Companion PC (it follows the main PC): the backup is the main PC's. "Back
// up now" goes there; the main PC off → kept here and sent again every minute
// until it answers (one request, however many clicks).
async function onMain(method, p) {
  const r = await fetch(`${mainURL()}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-adal-pc': await mainKey() }, body: method === 'GET' ? undefined : '{}', signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `the main PC answered ${r.status}`)
  return j
}
let forMain = null
function askMainLater() {
  if (forMain) return
  forMain = setInterval(() => {
    if (!isFollower()) { clearInterval(forMain); forMain = null; return }
    onMain('POST', '/backup/run').then(() => { clearInterval(forMain); forMain = null; console.log('[backup] the main PC took the backup asked here') }).catch(() => {})
  }, 60 * 1000)
  forMain.unref?.()
}

router.get('/backup', async (req, res) => {
  if (isFollower()) {
    try { const j = await onMain('GET', '/backup'); return res.json({ progress: j.progress || {}, on_main: true, queued: !!forMain }) }
    catch { return res.json({ progress: {}, on_main: true, queued: !!forMain }) }
  }
  res.json(onThisPC(req) ? { ...getConfig(), progress } : { progress })
})
router.post('/backup/settings', here, (req, res) => { try { res.json(saveConfig(req.body || {})) } catch (e) { fail(res, e) } })
router.get('/backup/bot', here, async (req, res) => { try { res.json(await botInfo()) } catch (e) { fail(res, e) } })
router.post('/backup/find-chats', here, async (req, res) => { try { res.json(await findChats(req.body?.agency)) } catch (e) { fail(res, e) } })
router.post('/backup/test', here, async (req, res) => { try { res.json(await testConnection()) } catch (e) { fail(res, e) } })
router.post('/backup/run', async (req, res) => {
  if (isFollower()) {
    try { return res.json({ ...(await onMain('POST', '/backup/run')), on_main: true }) }
    catch (e) {
      askMainLater()
      return res.json({ queued: true, on_main: true, message: `The main PC does not answer (${e.message}): the backup is asked again every minute until it does.` })
    }
  }
  // A backup already going: this one follows it by itself (never a second click).
  if (progress.running) { backupSoon(); return res.json({ busy: true, queued: true }) }
  // Never waits: Telegram when it answers, otherwise the online storage;
  // neither → it is tried again by itself within minutes.
  runBackup(req.app.locals.db, { force: true })
    .then(r => console.log('[backup] done', r))
    .catch(e => { backupSoon(); console.warn('[backup] failed:', e.message, '— tried again by itself') })
  res.json({ started: true })
})
router.post('/backup/restore', here, upload.single('index'), async (req, res) => {
  try {
    let indexBuf = req.file?.buffer, password = req.body.password
    if (!indexBuf) { const b = await newestBackup(req.app.locals.db); indexBuf = b.index; password ||= b.key }
    const r = await restoreFrom(indexBuf, { bot_token: req.body.bot_token, password })
    res.json({ ...r, restart: true })
    if (r.database && process.platform === 'win32') setTimeout(() => process.exit(0), 1000) // the launcher starts it again
  } catch (e) { fail(res, e) }
})

export default router
