#!/usr/bin/env node
/**
 * Makes "Adal Seller (PRIVATE).html" — the page only YOU keep.
 *
 *   node seller/make-seller-page.mjs
 *
 * The customer calls and says their 6-digit PC number. Type it into the
 * page: it shows a QR code. Scan it once with Google Authenticator ("+" →
 * "Scan a QR code"); from then on the app shows that customer's code.
 * Read them the code; they type it on the lock screen and the PC is
 * unlocked for good. The page also shows the live code itself, in case your
 * phone is not at hand.
 *
 * The page carries ADAL_LICENSE_KEY (from adal-keep-backend/.env): anyone
 * with it can unlock any PC. Never send it, never commit it (git ignores it).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const envText = fs.readFileSync(path.join(here, '..', 'adal-keep-backend', '.env'), 'utf8')
const key = (envText.match(/^ADAL_LICENSE_KEY=(.+)$/m) || [])[1]?.trim()
if (!key) { console.error('ADAL_LICENSE_KEY is missing from adal-keep-backend/.env'); process.exit(1) }
const qrLib = fs.readFileSync(path.join(here, 'qrcode-generator-1.4.4.min.js'), 'utf8')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Adal Seller</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font-family: system-ui, Segoe UI, sans-serif; color: #f1f5f9;
         background: radial-gradient(60% 50% at 15% 10%, #4c1d95 0%, transparent 70%),
                     radial-gradient(50% 50% at 90% 90%, #9d174d 0%, transparent 70%), #07070d;
         display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { width: 100%; max-width: 760px; border-radius: 24px; padding: 2px;
          background: linear-gradient(120deg, #22d3ee, #a78bfa, #f472b6, #fb923c); }
  .in { border-radius: 22px; background: rgba(10,10,20,.92); padding: 28px; display: grid; gap: 24px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 680px) { .in { grid-template-columns: 1fr; } }
  h1 { margin: 0 0 4px; font-size: 26px; background: linear-gradient(90deg,#22d3ee,#a78bfa,#f472b6); -webkit-background-clip: text; color: transparent; }
  p { margin: 0; color: #94a3b8; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #a78bfa; margin: 18px 0 6px; }
  input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 18px; }
  #pc { font-size: 28px; letter-spacing: .3em; font-family: ui-monospace, monospace; text-align: center; }
  .bad { color: #fb7185; font-size: 13px; min-height: 18px; margin-top: 6px; }
  .qrbox { background: #fff; border-radius: 16px; padding: 14px; display: flex; align-items: center; justify-content: center; min-height: 260px; color: #64748b; font-size: 14px; text-align: center; }
  .code { margin-top: 16px; text-align: center; }
  .code b { display: block; font-size: 44px; letter-spacing: .18em; font-family: ui-monospace, monospace;
            background: linear-gradient(90deg,#22d3ee,#a78bfa,#f472b6,#fb923c); -webkit-background-clip: text; color: transparent; }
  .bar { height: 4px; border-radius: 4px; background: linear-gradient(90deg,#22d3ee,#f472b6); transition: width 1s linear; }
  ol { color: #cbd5e1; font-size: 14px; padding-left: 18px; margin: 14px 0 0; line-height: 1.7; }
</style></head>
<body><div class="card"><div class="in">
  <div>
    <h1>Adal Seller</h1>
    <p>Private — this page can unlock any Adal Keep. Keep it on your PC only.</p>
    <label for="pc">Customer's PC number</label>
    <input id="pc" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off">
    <div class="bad" id="bad"></div>
    <label for="name">Customer name (shown in Authenticator)</label>
    <input id="name" placeholder="e.g. Sunrise Agency" autocomplete="off">
    <ol>
      <li>Google Authenticator → <b>+</b> → <b>Scan a QR code</b>.</li>
      <li>Scan the QR once per customer.</li>
      <li>Read them the 6-digit code. It changes every 30 s; they have about a minute.</li>
    </ol>
  </div>
  <div>
    <div class="qrbox" id="qr">Type a PC number</div>
    <div class="code" id="codebox" hidden>
      <p>Current code (same as Authenticator)</p>
      <b id="code">------</b>
      <div class="bar" id="bar" style="width:100%"></div>
    </div>
  </div>
</div></div>
<script>${qrLib}</script>
<script>
const KEY = ${JSON.stringify(key)};
const enc = new TextEncoder();
const luhnDigit = (digits) => { let sum = 0; for (let i = 0; i < digits.length; i++) { let d = +digits[digits.length - 1 - i]; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 } sum += d } return String((10 - sum % 10) % 10) };
const isPc = (n) => /^\\d{6}$/.test(n) && luhnDigit(n.slice(0, 5)) === n[5];
async function hmac(alg, keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: alg }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const base32 = (bytes) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5 } } if (bits) out += A[(val << (5 - bits)) & 31]; return out };
async function secretFor(pc) { return (await hmac('SHA-256', enc.encode(KEY), enc.encode('adal-keep-totp:' + pc))).slice(0, 20) }
async function totp(secret, step) {
  const msg = new Uint8Array(8); let s = step; for (let i = 7; i >= 0; i--) { msg[i] = s & 255; s = Math.floor(s / 256) }
  const h = await hmac('SHA-1', secret, msg); const o = h[19] & 15;
  const n = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(n).padStart(6, '0');
}
const $ = (id) => document.getElementById(id);
let current = null;
async function render() {
  const pc = $('pc').value.replace(/\\D/g, '');
  const name = $('name').value.trim() || 'Customer';
  current = null; $('codebox').hidden = true; $('bad').textContent = '';
  if (pc.length < 6) { $('qr').textContent = 'Type a PC number'; return }
  if (!isPc(pc)) { $('bad').textContent = 'This PC number is not valid — ask them to read it again.'; $('qr').textContent = '—'; return }
  if (!window.crypto?.subtle) { $('bad').textContent = 'Open this page in Brave or Chrome.'; return }
  const secret = await secretFor(pc);
  const label = encodeURIComponent('Adal Keep:' + name + ' ' + pc);
  const uri = 'otpauth://totp/' + label + '?secret=' + base32(secret) + '&issuer=Adal%20Keep&algorithm=SHA1&digits=6&period=30';
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $('qr').firstChild.style.width = '100%'; $('qr').firstChild.style.maxWidth = '300px';
  current = secret; $('codebox').hidden = false; tick();
}
async function tick() {
  if (!current) return;
  const now = Date.now() / 1000;
  $('code').textContent = await totp(current, Math.floor(now / 30));
  $('bar').style.width = ((30 - now % 30) / 30 * 100) + '%';
}
$('pc').addEventListener('input', render); $('name').addEventListener('input', render);
setInterval(tick, 1000);
</script></body></html>`

const out = path.join(here, 'Adal Seller (PRIVATE).html')
fs.writeFileSync(out, html)
console.log('Wrote', out)
