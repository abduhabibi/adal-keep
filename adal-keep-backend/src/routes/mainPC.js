/**
 * /api/main-pc — Settings → "Main PC".
 *   GET               this PC's role and addresses (LAN, Tailscale)
 *   POST {main_url}   follow that main PC ('' = this PC is the main PC)
 *   POST /https       give this PC an https address on the private link
 * Changing it works only from a browser on this PC itself.
 */
import express from 'express'
import { describe, checkMainPC, setMainURL, turnOnHttps } from '../services/mainPC.js'
import { onThisPC } from './trash.js'

const router = express.Router()

router.get('/main-pc', async (req, res) => {
  try { res.json({ ...(await describe()), on_this_pc: onThisPC(req) }) } catch (e) { res.status(500).json({ error: e.message }) }
})

const thisPCOnly = (req, res, next) => (onThisPC(req)
  ? next()
  : res.status(403).json({ error: 'Change this on the PC itself (open Adal Keep on that PC).' }))

router.post('/main-pc', thisPCOnly, async (req, res) => {
  try {
    const url = req.body?.main_url ? await checkMainPC(req.body.main_url) : ''
    setMainURL(url)
    res.json({ ok: true, restart: true, ...(await describe()) })
    // Restart so automations, the inbox watcher and network discovery follow
    // the new choice. The launcher (AdalKeep.exe) starts the server again.
    if (process.platform === 'win32') setTimeout(() => process.exit(0), 800)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/main-pc/https', thisPCOnly, async (req, res) => {
  try { res.json({ ok: true, tailscale: await turnOnHttps() }) } catch (e) { res.status(400).json({ error: e.message }) }
})

export default router
