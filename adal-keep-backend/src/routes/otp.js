/**
 * /api/otp — sign-in codes (see services/otp.js).
 *
 *   POST /api/otp/sms?key=…   the SMS phone forwards a text message here
 *                             (needs the key; reachable from the phone)
 *   GET  /api/otp             Settings card (main PC only)
 *   POST /api/otp/totp        { secret } save the Musaned authenticator key
 *   DELETE /api/otp/totp      remove it
 *   POST /api/otp/sms-key     a new key (the old phone link stops working)
 */
import express from 'express'
import { onThisPC } from './trash.js'
import { hasTotp, saveTotp, removeTotp, totpNow, smsKey, newSmsKey, smsKeyOk, receiveSms, smsStatus } from '../services/otp.js'
import { describe } from '../services/mainPC.js'
import { openBrowserIfAny } from '../services/browser.js'

const router = express.Router()
const here = (req, res, next) => (onThisPC(req) ? next() : res.status(403).json({ error: 'Sign-in codes are set up on the main PC itself.' }))

// Forwarder apps send JSON, a form or plain text — accept all three.
const anyBody = [express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' }), express.text({ type: () => true, limit: '32kb' })]
const pickText = (b) => {
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { return { text: b, from: '' } } }
  b = b || {}
  // Unknown field names: look for the code anywhere in what was sent.
  const text = b.text ?? b.message ?? b.msg ?? b.body ?? b.content ?? b.sms ?? Object.entries(b).flat().join(' ')
  const from = b.from ?? b.sender ?? b.phone ?? b.number ?? b.address ?? ''
  return { text: String(text), from: String(from) }
}

router.post('/otp/sms', anyBody, (req, res) => {
  if (!smsKeyOk(req.query.key || req.get('x-adal-key'))) return res.status(401).json({ error: 'wrong key' })
  const code = receiveSms(pickText(req.body))
  res.json({ ok: true, code_found: !!code })
})

router.get('/otp', here, async (req, res) => {
  const info = await describe().catch(() => ({ lan: [], tailscale: {} }))
  const key = smsKey()
  const path = `/api/otp/sms?key=${key}`
  const ts = info.tailscale || {}
  res.json({
    musaned_totp: hasTotp('musaned'),
    sms: { ...smsStatus },
    sms_urls: {
      office: (info.lan || []).map(u => u + path),
      tailscale: ts.ip ? `http://${ts.ip}:${info.port || 4000}${path}` : null,
    },
  })
})

router.post('/otp/totp', here, (req, res) => {
  try {
    saveTotp('musaned', req.body?.secret)
    res.json({ ok: true, now: totpNow('musaned') })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// Pictures of the open Musaned tabs: the page finds the QR code in them and
// reads the authenticator key from it (Musaned shows no "Unable to scan?").
router.get('/otp/musaned-tab-shots', here, async (req, res) => {
  try {
    const browser = await openBrowserIfAny()
    if (!browser) return res.json({ shots: [], why: 'The Adal Keep browser is not open.' })
    const tabs = (await browser.pages()).filter(p => /wahid\.sa|musaned/i.test(p.url())).slice(0, 3)
    const shots = []
    for (const p of tabs) {
      try { shots.push(await p.screenshot({ type: 'png', encoding: 'base64', fullPage: true })) } catch {}
    }
    res.json({ shots, why: tabs.length ? '' : 'No Musaned tab is open in the Adal Keep browser.' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/otp/totp/now', here, (req, res) => res.json(totpNow('musaned')))
router.delete('/otp/totp', here, (req, res) => { removeTotp('musaned'); res.json({ ok: true }) })
router.post('/otp/sms-key', here, (req, res) => { newSmsKey(); res.json({ ok: true }) })

export default router
