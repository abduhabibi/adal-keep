/**
 * /api/main-pc — Settings → "Main PC".
 *   GET               this PC's role and addresses (LAN, Tailscale)
 *   POST {main_url}   follow that main PC ('' = this PC is the main PC)
 *   POST /https       give this PC an https address on the private link
 * Changing it works only from a browser on this PC itself.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { describe, checkMainPC, setMainURL, turnOnHttps, mainKey } from '../services/mainPC.js'
import { onThisPC } from './trash.js'

const router = express.Router()

router.get('/main-pc', async (req, res) => {
  try { res.json({ ...(await describe()), on_this_pc: onThisPC(req) }) } catch (e) { res.status(500).json({ error: e.message }) }
})

const thisPCOnly = (req, res, next) => (onThisPC(req)
  ? next()
  : res.status(403).json({ error: 'Change this on the PC itself (open Adal Keep on that PC).' }))

// Open Adal Keep's window when this PC starts: off until someone allows it here.
// (The server itself always starts, without any window. AdalKeep.exe reads this.)
const START_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'open-at-start.json')
router.get('/main-pc/open-at-start', (req, res) => {
  try { res.json({ on: JSON.parse(fs.readFileSync(START_FILE, 'utf8')).on === true }) } catch { res.json({ on: false }) }
})
router.post('/main-pc/open-at-start', thisPCOnly, (req, res) => {
  fs.mkdirSync(path.dirname(START_FILE), { recursive: true })
  fs.writeFileSync(START_FILE, JSON.stringify({ on: !!req.body?.on }))
  res.json({ on: !!req.body?.on })
})

router.post('/main-pc', thisPCOnly, async (req, res) => {
  try {
    const url = req.body?.main_url ? await checkMainPC(req.body.main_url) : ''
    // Signed in with the main PC's account: let in there at once (no "Yes" needed). Checked first.
    const { username, password } = req.body || {}
    if (url && username && password) {
      const had = (await describe()).main_url || ''
      setMainURL(url)
      try { await mainKey({ username, password }) } catch (e) { setMainURL(had); return res.status(400).json({ error: e.message }) }
    } else setMainURL(url)
    res.json({ ok: true, restart: true, signed_in: !!(url && username && password), ...(await describe()) })
    // Restart so automations, the inbox watcher and network discovery follow
    // the new choice. The launcher (AdalKeep.exe) starts the server again.
    if (process.platform === 'win32') setTimeout(() => process.exit(0), 800)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/main-pc/https', thisPCOnly, async (req, res) => {
  try { res.json({ ok: true, tailscale: await turnOnHttps() }) } catch (e) { res.status(400).json({ error: e.message }) }
})

export default router
