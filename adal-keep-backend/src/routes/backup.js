/**
 * /api/backup — the Telegram off-site backup (Settings → Backup).
 * Setting it up, running it now and restoring work only on the main PC itself.
 */
import express from 'express'
import multer from 'multer'
import { getConfig, saveConfig, testConnection, findChats, botInfo, runBackup, progress, restoreFrom, newestBackup, backupSoon } from '../services/telegramBackup.js'
import { onThisPC, fromCompanion } from './trash.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
const here = (req, res, next) => (onThisPC(req) || fromCompanion(req) ? next() : res.status(403).json({ error: 'Backups are set up on the main PC itself.' }))
const fail = (res, e) => res.status(400).json({ error: e.message })

router.get('/backup', here, (req, res) => res.json({ ...getConfig(), progress }))
router.post('/backup/settings', here, (req, res) => { try { res.json(saveConfig(req.body || {})) } catch (e) { fail(res, e) } })
router.get('/backup/bot', here, async (req, res) => { try { res.json(await botInfo()) } catch (e) { fail(res, e) } })
router.post('/backup/find-chats', here, async (req, res) => { try { res.json(await findChats(req.body?.agency)) } catch (e) { fail(res, e) } })
router.post('/backup/test', here, async (req, res) => { try { res.json(await testConnection()) } catch (e) { fail(res, e) } })
router.post('/backup/run', here, async (req, res) => {
  if (progress.running) return res.json({ busy: true })
  // The Companion and the phones work from the online copy: while it is still
  // being filled the heavy backup waits, and starts by itself after.
  const { onlineCopyFilling } = await import('../services/cloudSync.js')
  if (onlineCopyFilling()) {
    backupSoon()
    return res.json({ waiting: true, message: 'The online copy for the Companion and the phones goes first. The backup starts by itself when it is done.' })
  }
  runBackup(req.app.locals.db, { force: true }).catch(e => console.warn('[backup] failed:', e.message))
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
