/**
 * /api/backup — the Telegram off-site backup (Settings → Backup).
 * Setting it up, running it now and restoring work only on the main PC itself.
 */
import express from 'express'
import multer from 'multer'
import { getConfig, saveConfig, testConnection, findChats, runBackup, progress, restoreFrom } from '../services/telegramBackup.js'
import { onThisPC } from './trash.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
const here = (req, res, next) => (onThisPC(req) ? next() : res.status(403).json({ error: 'Backups are set up on the main PC itself.' }))
const fail = (res, e) => res.status(400).json({ error: e.message })

router.get('/backup', here, (req, res) => res.json({ ...getConfig(), progress }))
router.post('/backup/settings', here, (req, res) => { try { res.json(saveConfig(req.body || {})) } catch (e) { fail(res, e) } })
router.post('/backup/find-chats', here, async (req, res) => { try { res.json(await findChats()) } catch (e) { fail(res, e) } })
router.post('/backup/test', here, async (req, res) => { try { res.json(await testConnection()) } catch (e) { fail(res, e) } })
router.post('/backup/run', here, (req, res) => {
  if (progress.running) return res.json({ busy: true })
  runBackup(req.app.locals.db, { force: true }).catch(e => console.warn('[backup] failed:', e.message))
  res.json({ started: true })
})
router.post('/backup/restore', here, upload.single('index'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Choose the newest "adal-backup-index.enc" from the Telegram channel.')
    const r = await restoreFrom(req.file.buffer, { bot_token: req.body.bot_token, password: req.body.password })
    res.json({ ...r, restart: true })
    if (r.database && process.platform === 'win32') setTimeout(() => process.exit(0), 1000) // the launcher starts it again
  } catch (e) { fail(res, e) }
})

export default router
