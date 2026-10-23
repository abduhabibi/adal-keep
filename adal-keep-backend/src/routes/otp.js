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
import { hasTotp, saveTotp, removeTotp, totpNow, smsKey, newSmsKey, smsKeyOk, receiveSms, smsStatus, phoneSeen } from '../services/otp.js'
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

/**
 * The page the SMS phone opens (from the QR code in Settings). Opening it
 * proves the phone reaches this PC; it shows the link for the SMS app with a
 * Copy button and a "Send a test" button.
 */
router.get('/otp/phone', (req, res) => {
  const ok = smsKeyOk(req.query.key)
  if (ok) phoneSeen()
  const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '')
  const link = `http://${host}/api/otp/sms?key=${encodeURIComponent(String(req.query.key || ''))}`
  const tpl = '{"from":"%from%","text":"%text%"}'
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Adal Keep phone</title>
<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f8fafc;color:#0f172a}
.ok{background:#dcfce7;border-radius:14px;padding:14px;font-weight:600}.bad{background:#fee2e2;border-radius:14px;padding:14px;font-weight:600}
h2{font-size:18px;margin:22px 0 6px}textarea{width:100%;box-sizing:border-box;font:14px monospace;padding:8px;border:1px solid #cbd5e1;border-radius:10px;height:70px}
button{display:block;width:100%;margin-top:8px;padding:14px;font:600 17px system-ui;border:0;border-radius:12px;background:#0d9488;color:#fff}
.s{color:#475569;font-size:15px}#r{margin-top:8px;font-weight:600}</style></head><body>
${ok ? `<div class="ok">✅ This phone reaches Adal Keep.</div>
<h2>1. Copy the link for the SMS app</h2>
<textarea id="l" readonly>${esc(link)}</textarea><button onclick="cp('l',this)">Copy the link</button>
<h2>2. Copy the message template</h2>
<p class="s">Only needed if the app asks for a “JSON template”.</p>
<textarea id="t" readonly>${esc(tpl)}</textarea><button onclick="cp('t',this)">Copy the template</button>
<h2>3. Test the link</h2>
<button onclick="test()">Send a test to Adal Keep</button><div id="r"></div>
<p class="s">Then open the SMS forwarder app and paste the link there (see the guide in Settings → Sign-in codes).</p>`
  : `<div class="bad">❌ This link is old or wrong. Scan the QR code in Adal Keep → Settings → Sign-in codes again.</div>`}
<script>
function cp(id,b){var e=document.getElementById(id);e.focus();e.select();e.setSelectionRange(0,99999);var ok=false;try{ok=document.execCommand('copy')}catch(x){}
b.textContent=ok?'Copied ✓':'Press and hold the text to copy it'}
function test(){var r=document.getElementById('r');r.textContent='Sending…';
fetch(${JSON.stringify(link)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:'test',text:'ADAL-KEEP-TEST'})})
.then(function(x){r.textContent=x.ok?'✅ Adal Keep got the test. Settings now says the phone is connected.':'❌ Adal Keep said '+x.status}).catch(function(e){r.textContent='❌ '+e})}
</script></body></html>`)
})

router.get('/otp', async (req, res) => {
  // Every agency PC shows the phone QR code; only the main PC can make a new link
  // or remove the Musaned key.
  const info = await describe().catch(() => ({ lan: [], tailscale: {} }))
  const key = smsKey()
  const path = `/api/otp/sms?key=${key}`
  const ts = info.tailscale || {}
  const port = info.port || 4000
  const office = [...(info.lan || [])]
  // The address this browser used to reach the main PC reaches it from the phone too.
  const host = String(req.headers.host || '')
  if (host && !/^(localhost|127\.|\[::1\])/.test(host) && !host.startsWith('100.')) {
    const u = `http://${host}`
    if (!office.includes(u)) office.unshift(u)
  }
  res.json({
    here: onThisPC(req),
    musaned_totp: hasTotp('musaned'),
    sms: { ...smsStatus },
    sms_urls: {
      office: office.map(u => u + path),
      tailscale: ts.ip ? `http://${ts.ip}:${port}${path}` : null,
    },
    // What the phone scans: its own page with the link, Copy and Test buttons.
    phone_pages: {
      office: office.map(u => `${u}/api/otp/phone?key=${key}`),
      tailscale: ts.ip ? `http://${ts.ip}:${port}/api/otp/phone?key=${key}` : null,
    },
  })
})

// The QR code can be uploaded from any agency PC; the key is kept on the main PC.
router.post('/otp/totp', (req, res) => {
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
router.get('/otp/totp/now', (req, res) => res.json(totpNow('musaned')))
router.delete('/otp/totp', here, (req, res) => { removeTotp('musaned'); res.json({ ok: true }) })
router.post('/otp/sms-key', here, (req, res) => { newSmsKey(); res.json({ ok: true }) })

export default router
