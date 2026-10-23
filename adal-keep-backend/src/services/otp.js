/**
 * otp.js — sign-in codes typed by Adal Keep itself.
 *
 *   Musaned  authenticator (TOTP). The secret behind the QR code Musaned shows
 *            when an authenticator is added is kept here (locked to this PC);
 *            Adal Keep works out the same 6 digits the phone app shows.
 *   LMIS     SMS. A phone that receives the LMIS text messages forwards each
 *            one to POST /api/otp/sms?key=… (an SMS-forwarder app on Android,
 *            a Shortcuts automation on iPhone), over the office Wi-Fi or
 *            Tailscale. The code in it is typed into the LMIS page waiting
 *            for it.
 *
 * A watcher looks at the Adal Keep Brave every 2 seconds: a Musaned or LMIS
 * tab asking for a code gets it — during a run or when a person signs in by
 * hand. The reCAPTCHA is never touched: a person solves it.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { getSecret, setSecret } from './secretStore.js'
import { openBrowserIfAny } from './browser.js'

const MUSANED_HOST = 'accounts.wahid.sa'
const LMIS_HOST = 'lmis.gov.et'
const SMS_KEEP_MS = 10 * 60 * 1000

// ---------------------------------------------------------------- TOTP ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '')
  let bits = ''
  for (const ch of clean) {
    const v = B32.indexOf(ch)
    if (v < 0) throw new Error('This is not an authenticator key (letters A–Z and digits 2–7 only).')
    bits += v.toString(2).padStart(5, '0')
  }
  const out = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}

/** The key from "otpauth://totp/…?secret=XXXX" or the bare key Musaned shows. */
export function parseTotpInput(input) {
  const s = String(input || '').trim()
  if (!s) throw new Error('Paste the key (or the otpauth:// link) from the QR code.')
  let secret = s, digits = 6, period = 30, algorithm = 'SHA1'
  if (/^otpauth-migration:\/\//i.test(s)) return fromGoogleExport(s)
  if (/^otpauth:\/\//i.test(s)) {
    const u = new URL(s)
    secret = u.searchParams.get('secret') || ''
    digits = Number(u.searchParams.get('digits') || 6)
    period = Number(u.searchParams.get('period') || 30)
    algorithm = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase()
  }
  secret = secret.toUpperCase().replace(/[\s=-]/g, '')
  if (base32Decode(secret).length < 10) throw new Error('This key is too short — copy the whole key.')
  return { secret, digits, period, algorithm }
}

function base32Encode(buf) {
  let bits = '', out = ''
  for (const b of buf) bits += b.toString(2).padStart(8, '0')
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}

/**
 * Google Authenticator → Transfer accounts → Export shows a QR code with
 * "otpauth-migration://offline?data=…" (a small protobuf). The Musaned entry
 * (or the only one) is taken from it.
 */
function fromGoogleExport(uri) {
  const data = Buffer.from(decodeURIComponent(new URL(uri).searchParams.get('data') || ''), 'base64')
  const fields = (buf) => {
    const out = []
    let i = 0
    const varint = () => { let n = 0, sh = 0, b; do { b = buf[i++]; n += (b & 0x7f) * 2 ** sh; sh += 7 } while (b & 0x80); return n }
    while (i < buf.length) {
      const key = varint(), no = Math.floor(key / 8), type = key & 7
      if (type === 0) out.push([no, varint()])
      else if (type === 2) { const len = varint(); out.push([no, buf.subarray(i, i + len)]); i += len }
      else throw new Error('This QR code could not be read.')
    }
    return out
  }
  const accounts = fields(data).filter(([no]) => no === 1).map(([, b]) => {
    const f = Object.fromEntries(fields(b).map(([no, v]) => [no, v]))
    return {
      secret: base32Encode(f[1] || Buffer.alloc(0)),
      label: `${f[3] ? f[3].toString() : ''} ${f[2] ? f[2].toString() : ''}`.trim(),
      digits: f[5] === 2 ? 8 : 6,
      algorithm: ({ 2: 'SHA256', 3: 'SHA512' })[f[4]] || 'SHA1',
    }
  }).filter(a => a.secret)
  const a = accounts.find(a => /musaned|wahid|mol|hrsd/i.test(a.label)) || (accounts.length === 1 ? accounts[0] : null)
  if (!a) throw new Error(`This export has ${accounts.length} accounts (${accounts.map(a => a.label).join(', ')}). Export only the Musaned one.`)
  return { secret: a.secret, digits: a.digits, period: 30, algorithm: a.algorithm }
}

export function totpAt(cfg, time = Date.now()) {
  const counter = Math.floor(time / 1000 / cfg.period)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac(cfg.algorithm.toLowerCase(), base32Decode(cfg.secret)).update(msg).digest()
  const o = h[h.length - 1] & 0xf
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 10 ** cfg.digits).padStart(cfg.digits, '0')
}

const totpName = (portal) => `totp_${portal}`
export function hasTotp(portal = 'musaned') { return !!getSecret(totpName(portal)) }
export function saveTotp(portal, input) {
  const cfg = parseTotpInput(input)
  setSecret(totpName(portal), JSON.stringify(cfg))
  return cfg
}
export function removeTotp(portal) { setSecret(totpName(portal), '') }
/** Current code and seconds it stays valid, or null. */
export function totpNow(portal = 'musaned') {
  const raw = getSecret(totpName(portal))
  if (!raw) return null
  const cfg = JSON.parse(raw)
  const left = cfg.period - Math.floor(Date.now() / 1000) % cfg.period
  return { code: totpAt(cfg), seconds_left: left }
}

// ----------------------------------------------------------------- SMS ----

const sms = [] // { code, from, at, used } — kept in memory for 10 minutes only
export const smsStatus = { last_at: null, last_from: null, count: 0, phone_seen_at: null }

// When the phone was last heard from (its check page or an SMS), kept across
// restarts so Settings can say "phone connected".
const PHONE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/otp-phone.json')
try { Object.assign(smsStatus, JSON.parse(fs.readFileSync(PHONE_FILE, 'utf8'))) } catch {}
export function phoneSeen(extra = {}) {
  smsStatus.phone_seen_at = new Date().toISOString()
  Object.assign(smsStatus, extra)
  try { fs.writeFileSync(PHONE_FILE, JSON.stringify({ phone_seen_at: smsStatus.phone_seen_at, last_at: smsStatus.last_at, last_from: smsStatus.last_from, count: smsStatus.count })) } catch {}
}

export function smsKey() {
  let k = getSecret('otp_sms_key')
  if (!k) { k = crypto.randomBytes(18).toString('hex'); setSecret('otp_sms_key', k) }
  return k
}
export function newSmsKey() { const k = crypto.randomBytes(18).toString('hex'); setSecret('otp_sms_key', k); return k }
export function smsKeyOk(given) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(smsKey())
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** The code in a text message: 4–8 digits, preferring one next to "code"/"OTP". */
export function codeFromText(text) {
  const t = String(text || '')
  const near = t.match(/(?:code|otp|pin|verification|ኮድ)[^0-9]{0,30}(\d{4,8})\b/i) || t.match(/\b(\d{4,8})\b[^0-9]{0,30}(?:is your|code|otp)/i)
  if (near) return near[1]
  return t.match(/\b(\d{4,8})\b/)?.[1] || null
}

/** An SMS the phone forwarded. Returns the code found, or null. */
export function receiveSms({ from = '', text = '' }) {
  // The test button on the phone page: counts as "phone works", never as a code.
  const code = /ADAL-KEEP-TEST/.test(text) ? null : codeFromText(text)
  smsStatus.last_at = new Date().toISOString()
  smsStatus.last_from = String(from || '').slice(0, 40)
  smsStatus.count++
  phoneSeen()
  if (!code) return null
  const now = Date.now()
  while (sms.length && now - sms[0].at > SMS_KEEP_MS) sms.shift()
  sms.push({ code, from: smsStatus.last_from, at: now, used: false })
  console.log(`[otp] SMS code received from ${smsStatus.last_from || 'the phone'}`)
  return code
}

/** The newest unused code that arrived after `since` (ms), or null. */
export function takeSmsCode(since) {
  for (let i = sms.length - 1; i >= 0; i--) {
    const s = sms[i]
    if (s.at < since) break
    if (!s.used) { s.used = true; return s.code }
  }
  return null
}

// ------------------------------------------------------------ the page ----

/** Marks the code input(s) of a sign-in page; how many boxes (0 = none). */
async function markOtpInputs(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('input')].filter(i => {
      if (/^(hidden|password|checkbox|radio|submit|button|email|file)$/i.test(i.type)) return false
      const r = i.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && !i.disabled && !i.readOnly
    })
    const hint = (i) => [i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.autocomplete, i.closest('label')?.textContent]
      .filter(Boolean).join(' ')
    const boxes = all.filter(i => i.maxLength === 1 && /numeric|tel|number|text/i.test(i.inputMode || i.type))
    let pick = boxes.length >= 4 && boxes.length <= 8 ? boxes : []
    if (!pick.length) {
      const one = all.find(i => i.autocomplete === 'one-time-code' || /otp|totp|one.?time|verification|code|pin/i.test(hint(i)))
      if (one && !/user|phone|mobile|search/i.test(hint(one))) pick = [one]
    }
    document.querySelectorAll('[data-adal-otp]').forEach(e => e.removeAttribute('data-adal-otp'))
    pick.forEach((e, n) => e.setAttribute('data-adal-otp', String(n)))
    return pick.length
  }).catch(() => 0)
}

/** Types the code and sends it (Enter, then the Verify / Sign In button). */
async function typeCode(page, code, host) {
  const n = await markOtpInputs(page)
  if (!n) return false
  const els = await page.$$('[data-adal-otp]')
  if (n === 1) {
    await els[0].evaluate(e => { e.focus(); e.value = '' })
    await els[0].type(code, { delay: 40 })
  } else {
    for (let i = 0; i < els.length && i < code.length; i++) await els[i].type(code[i], { delay: 30 })
  }
  await els[els.length - 1].press('Enter').catch(() => {})
  await new Promise(r => setTimeout(r, 1500))
  if (await markOtpInputs(page)) {
    // Still there: press the page's own button. On LMIS never a "Submit"
    // button (that word is kept for application forms).
    await page.evaluate((host) => {
      const btns = [...document.querySelectorAll('button, input[type=submit]')]
      const label = (b) => (b.innerText || b.value || '').trim()
      const ok = host.includes('wahid') ? /verify|sign\s*in|log\s*in|continue|submit/i : /verify|confirm|continue|sign\s*in|log\s*in/i
      const b = btns.find(b => ok.test(label(b)) && !(host.includes('lmis') && /submit/i.test(label(b))))
      b?.click()
    }, host).catch(() => {})
  }
  return true
}

let _jsqr = null
const jsQR = () => (_jsqr ||= ((m) => m.default || m)(createRequire(import.meta.url)('../vendor/jsQR.cjs')))

/**
 * Musaned shows a QR code once, when it asks to set up an authenticator.
 * The key is read straight from that QR code on the page (nobody copies
 * anything): returns the otpauth:// text, or null.
 */
export async function qrOnPage(page) {
  const looks = await page.evaluate(() =>
    /authenticator|scan|qr|barcode/i.test(document.body?.innerText || '') && !!document.querySelector('img, canvas, svg')
  ).catch(() => false)
  if (!looks) return null
  const sharp = (await import('sharp')).default
  const png = await page.screenshot({ type: 'png', fullPage: true })
  const meta = await sharp(png).metadata()
  for (const scale of [1, 0.5, 2]) {
    const width = Math.round(meta.width * scale)
    if (width < 200 || width * Math.round(meta.height * scale) > 16e6) continue
    const { data, info } = await sharp(png).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const r = jsQR()(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'attemptBoth' })
    if (r?.data && /^otpauth(-migration)?:\/\//i.test(r.data)) return r.data
  }
  return null
}

const filled = new Map() // tab → { code, at }

/** One look at one tab: a code page gets its code. */
export async function serveTab(page) {
  const url = page.url()
  const portal = url.includes(MUSANED_HOST) ? 'musaned' : url.includes(LMIS_HOST) ? 'lmis' : null
  if (!portal) return false
  const key = page.target()._targetId || url
  const seen = filled.get(key)
  if (!(await markOtpInputs(page))) {
    if (seen && !seen.pageSince) filled.delete(key)
    return false
  }
  const now = Date.now()
  if (portal === 'musaned') {
    if (!hasTotp('musaned')) {
      // First time: Musaned shows its authenticator QR code — keep the key.
      const uri = await qrOnPage(page).catch(() => null)
      if (!uri) return false
      saveTotp('musaned', uri)
      console.log('[otp] Musaned authenticator key read from its QR code and saved')
      // Keycloak may ask a name for the device.
      await page.evaluate(() => {
        const n = document.querySelector('input[name="userLabel"], #userLabel')
        if (n && !n.value) { n.value = 'Adal Keep'; n.dispatchEvent(new Event('input', { bubbles: true })) }
      }).catch(() => {})
    }
    const t = totpNow('musaned')
    if (!t) return false
    // Only a code with more than 4 seconds left: one about to change may be
    // refused on arrival, so wait for the next one.
    if (t.seconds_left <= 4) return false
    if (seen?.code === t.code && now - seen.at < 30000) return false
    if (await typeCode(page, t.code, MUSANED_HOST)) {
      filled.set(key, { code: t.code, at: now })
      console.log('[otp] Musaned authenticator code typed')
      return true
    }
    return false
  }
  // LMIS: the SMS may have come a little before the code page showed.
  const since = (seen?.pageSince || now) - 90 * 1000
  if (!seen) filled.set(key, { pageSince: now })
  const code = takeSmsCode(since)
  if (!code) return false
  if (await typeCode(page, code, LMIS_HOST)) {
    filled.set(key, { pageSince: seen?.pageSince || now, code, at: now })
    console.log('[otp] LMIS SMS code typed')
    return true
  }
  return false
}

/** True when this tab is asking for a code now (used by the LMIS sign-in). */
export async function pageWantsCode(page) { return (await markOtpInputs(page)) > 0 }

/** Ticks Musaned's "Remember me" when it is not ticked yet. */
export async function tickRememberMe(page) {
  return page.evaluate(() => {
    const labelOf = (c) => (c.closest('label')?.textContent || (c.id && document.querySelector(`label[for="${c.id}"]`)?.textContent) || '')
    const b = document.querySelector('#rememberMe, input[name="rememberMe"]') ||
      [...document.querySelectorAll('input[type=checkbox]')].find(c => /remember|تذكر/i.test(labelOf(c)))
    if (b && !b.checked) { b.click(); return true }
    return false
  }).catch(() => false)
}

// Tabs a Musaned run signs in itself (musanedWorkflow.js): the watcher leaves them alone.
const held = new Set()
const tabKey = (page) => page.target()._targetId || page.url()
export function holdTab(page, on) { const k = tabKey(page); if (on) held.add(k); else held.delete(k) }

/**
 * A Musaned sign-in page opened by hand in the Adal Keep browser: the saved
 * Musaned user name and password are filled, "Remember me" is ticked, and
 * once a person has ticked "I'm not a robot" Sign In is pressed. Adal Keep
 * never ticks "I'm not a robot" itself; when nobody has after 20 seconds it
 * rings once to ask.
 */
const logins = new Map() // tab → what was done on this sign-in page
async function serveMusanedLogin(page, { getAccount, notify }) {
  const k = tabKey(page)
  if (held.has(k)) return
  const st = await page.evaluate(() => {
    const pw = document.querySelector('#password, input[name="password"], input[type="password"]')
    if (!pw || !pw.getBoundingClientRect().width) return null
    const user = document.querySelector('#username, input[name="username"], input[autocomplete="username"]')
    return {
      href: location.href,
      user: user?.value || '', pw: pw.value || '',
      captcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]'),
      token: [...document.querySelectorAll('textarea[name="g-recaptcha-response"]')].map(t => t.value || '').find(v => v.length > 20) || '',
    }
  }).catch(() => null)
  if (!st) { logins.delete(k); return }
  let s = logins.get(k)
  if (!s || s.href !== st.href) { s = { href: st.href, since: Date.now() }; logins.set(k, s) }

  if (!s.filled) {
    s.filled = true
    if (!st.user && !st.pw) {
      const acct = await getAccount().catch(() => null)
      if (acct?.username && acct?.password) {
        await page.evaluate((u, p) => {
          const set = (el, v) => {
            if (!el) return
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
          }
          set(document.querySelector('#username, input[name="username"], input[autocomplete="username"]'), u)
          set(document.querySelector('#password, input[name="password"], input[type="password"]'), p)
        }, acct.username, acct.password).catch(() => {})
        st.user = acct.username; st.pw = acct.password
        console.log('[otp] Musaned sign-in page: user name and password filled')
      }
    }
  }
  if (!s.remembered) { s.remembered = true; if (await tickRememberMe(page)) console.log('[otp] Musaned "Remember me" ticked') }
  if (!st.user || !st.pw) return

  if (st.token && st.token !== s.token) {
    s.token = st.token
    console.log('[otp] Musaned "I\'m not a robot" is ticked — pressing Sign In')
    await page.evaluate(() => (document.querySelector('#kc-login') || document.querySelector('button[type="submit"], input[type="submit"]'))?.click()).catch(() => {})
    return
  }
  if (st.captcha && !st.token && !s.told && Date.now() - s.since > 20000) {
    s.told = true
    await notify('🖐 Musaned: tick "I\'m not a robot"',
      'The Musaned sign-in page is filled. Tick "I\'m not a robot" (and the pictures, if Google shows some); Adal Keep presses Sign In and types the code.').catch(() => {})
  }
}

let timer = null
export function startOtpWatcher(opts = {}) {
  if (timer) return
  let busy = false
  timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const browser = await openBrowserIfAny()
      if (!browser) return
      for (const page of await browser.pages()) {
        const u = page.url()
        if (u.includes(MUSANED_HOST) && opts.getAccount) await serveMusanedLogin(page, opts).catch(() => {})
        if (u.includes(MUSANED_HOST) || u.includes(LMIS_HOST)) await serveTab(page).catch(() => {})
      }
    } catch {} finally { busy = false }
  }, 2000)
  timer.unref?.()
  console.log('🔑 Sign-in codes: Musaned authenticator + LMIS SMS watcher on')
}
