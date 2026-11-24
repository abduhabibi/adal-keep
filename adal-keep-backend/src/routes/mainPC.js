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
import { supportOn, setSupport } from '../services/supportSwitch.js'

const router = express.Router()

router.get('/main-pc', async (req, res) => {
  try { res.json({ ...(await describe()), on_this_pc: onThisPC(req) }) } catch (e) { res.status(500).json({ error: e.message }) }
})

const thisPCOnly = (req, res, next) => (onThisPC(req)
  ? next()
  : res.status(403).json({ error: 'Change this on the PC itself (open Adal Keep on that PC).' }))

// Adal Keep's window never opens when this PC starts (the owner, 2026-11-24: "don't make Adal
// open by itself in any way"): the setting is gone, an old file is taken away, and an older page
// asking to turn it on gets "off".
const START_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'open-at-start.json')
try { fs.rmSync(START_FILE, { force: true }) } catch {}
router.get('/main-pc/open-at-start', (req, res) => res.json({ on: false, gone: true }))
router.post('/main-pc/open-at-start', thisPCOnly, (req, res) => res.json({ on: false, gone: true }))

// Remote support by Adal (default ON): off does what Adal Disconnect does; on puts it back.
router.get('/main-pc/support', (req, res) => res.json({ on: supportOn(), on_this_pc: onThisPC(req) }))
router.post('/main-pc/support', thisPCOnly, (req, res) => {
  try { res.json({ on: setSupport(!!req.body?.on) }) } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/main-pc', thisPCOnly, async (req, res) => {
  try {
    const url = req.body?.main_url ? await checkMainPC(req.body.main_url) : ''
    // The main PC's number (5 digits, in its Settings): let in there at once, nobody approves. Checked first.
    const { number, username, password } = req.body || {}
    const had = (await describe()).main_url || ''
    const same = url && url === had
    if (url && (number || (username && password))) {
      setMainURL(url)
      try { await mainKey(number ? { number } : { username, password }) } catch (e) { setMainURL(had); return res.status(400).json({ error: e.message }) }
    } else if (url && !same) return res.status(400).json({ error: "Type the main PC's number (5 digits, in its Settings)" })
    else setMainURL(url)
    res.json({ ok: true, restart: true, signed_in: !!(url && (number || (username && password))), ...(await describe()) })
    // Restart so automations, the inbox watcher and network discovery follow
    // the new choice. The launcher (AdalKeep.exe) starts the server again.
    if (process.platform === 'win32') setTimeout(() => process.exit(0), 800)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/main-pc/https', thisPCOnly, async (req, res) => {
  try { res.json({ ok: true, tailscale: await turnOnHttps() }) } catch (e) { res.status(400).json({ error: e.message }) }
})

export default router
