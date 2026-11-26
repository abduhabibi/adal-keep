/**
 * Link WhatsApp by code (the owner, 2026-11-26: "they type the number and nothing continues").
 * Today's WhatsApp Web /login page has the linking part but no connection part
 * (WAWebSocketModel is null there), so the old shortcut waited 3 minutes for a code that never
 * came and never tried the page's own buttons. Now WhatsApp's own way comes first, the way a
 * person does it: "Log in with phone number" → the number → Next → its code. The internal
 * modules are only a shortcut when the page is ready for them.
 *
 * Every step is said (state.step) within seconds and kept (linkLog) so a failure at another
 * agency can be sent to Adal from the page. Off: ADAL_WA_BUTTONS_FIRST=0 (the old order).
 */
import dns from 'dns'
import os from 'os'

export const buttonsFirst = (env = process.env) => env.ADAL_WA_BUTTONS_FIRST !== '0'

/** +251 9…, 251 9…, 09…, 9… (Ethiopia), 00…: the digits WhatsApp wants (2519…). */
export function phoneDigits(v, country = '251') {
  let d = String(v || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = country + d.slice(1)
  else if (d.length === 9 && /^[79]/.test(d)) d = country + d
  if (d.startsWith(country + '0')) d = country + d.slice(country.length + 1)
  return d
}
/** A number in a log: the last 3 digits only. */
export const masked = (d) => { const s = String(d || ''); return s.length > 3 ? `…${s.slice(-3)}` : s }

// ------------------------------------------------------------------ steps --
const logs = new Map() // key → [{ at, step, error }]
export function noteStep(key, step, error = null) {
  const l = logs.get(key) || []
  l.push({ at: new Date().toISOString(), step: String(step).slice(0, 200), ...(error ? { error: String(error).slice(0, 300) } : {}) })
  while (l.length > 60) l.shift()
  logs.set(key, l)
  console.log(`[whatsapp ${key}] link: ${step}${error ? ` — ${error}` : ''}`)
}
export const linkLog = (key) => (logs.get(key) || []).slice()
export const _resetSteps = () => logs.clear()

/** Why WhatsApp's page did not come: no internet at all, or only WhatsApp not answering. */
export function whyNoPage(lookup = dns.promises.lookup) {
  return Promise.race([
    lookup('web.whatsapp.com').then(() => 'WhatsApp\'s page is not loading on this PC (slow internet, or WhatsApp blocked here).', () => 'No internet on this PC.'),
    new Promise(r => setTimeout(() => r('No internet on this PC (the name web.whatsapp.com did not answer).'), 8000)),
  ])
}

// --------------------------------------------------- WhatsApp's own buttons --
const BOX = 'input[aria-label*="phone number" i], input[type="tel"]'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** In the page: what it shows now. */
function pageNow() {
  const leaf = [...document.querySelectorAll('button,[role=button],a,span,div')].filter(e => !e.children.length && e.offsetParent !== null)
  return {
    login: location.pathname.startsWith('/login'),
    phoneLink: leaf.some(e => /link with phone number|log in with phone number|phone number instead/i.test(e.textContent || '')),
    box: [...document.querySelectorAll('input[aria-label*="phone number" i], input[type="tel"]')].some(e => e.offsetParent !== null),
    qr: !!document.querySelector('[data-ref], canvas'),
  }
}
/** In the page: the 8-character code when it is shown. */
function readCodeIn() {
  const el = document.querySelector('[data-link-code]')
  if (el) { const c = el.getAttribute('data-link-code').replace(/[^A-Z0-9]/gi, ''); if (c.length === 8) return c }
  const text = document.body.innerText || ''
  if (!/code/i.test(text)) return ''
  // One box a character (WhatsApp's way): 8 single characters in a row.
  const one = [...document.querySelectorAll('span,div')].filter(e => !e.children.length && /^[A-Z0-9]$/.test((e.textContent || '').trim())).map(e => e.textContent.trim())
  for (let i = 0; i + 8 <= one.length; i++) { const c = one.slice(i, i + 8).join(''); if (/[A-Z]/.test(c)) return c }
  const t = text.match(/\b([A-Z0-9]{4})\s*-?\s*([A-Z0-9]{4})\b/)
  return t && /[A-Z]/.test(t[1] + t[2]) ? t[1] + t[2] : ''
}
/** In the page: WhatsApp's own words when it refuses the number. */
function refusalIn() {
  const said = [...document.querySelectorAll('[role=alert], [aria-live]')].map(e => e.innerText || '').join('\n') + '\n' + (document.body.innerText || '')
  const line = said.split('\n').map(s => s.trim()).find(s => /invalid|not valid|isn.t (a )?valid|not registered|couldn.t|could not|too many|try again later|wrong number|not a whatsapp/i.test(s))
  return line ? line.slice(0, 160) : ''
}
const clickPhoneLink = () => {
  const all = [...document.querySelectorAll('button,[role=button],a,span,div')].filter(x => !x.children.length && x.offsetParent !== null)
  // Its button first ("Log in with phone number"); the QR's hint text after.
  const e = all.find(x => /^\s*log in with phone number\s*$/i.test(x.textContent || '')) || all.find(x => /link with phone number|log in with phone number|phone number instead/i.test(x.textContent || ''))
  if (!e) return false
  ;(e.closest('button,[role=button],a') || e).click()
  return true
}
const clickNext = () => {
  const e = [...document.querySelectorAll('button,[role=button]')].find(x => /^next$/i.test((x.innerText || x.getAttribute('aria-label') || '').trim()))
  if (!e) return false
  e.click(); return true
}

export const readCode = (page) => page.evaluate(readCodeIn).catch(() => '')
export const pageState = (page) => page.evaluate(pageNow).catch(() => null)

/** The number in WhatsApp's box: whatever country it put there by itself is kept, never doubled. */
async function typeNumber(page, box, digits) {
  const clear = async () => { await box.click({ clickCount: 3 }); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace') }
  const value = () => page.evaluate((s) => document.querySelector(s)?.value || '', BOX).catch(() => '')
  await clear()
  const kept = (await value()).replace(/\D/g, '')   // the page puts "+251 " back by itself
  await box.type(kept && digits.startsWith(kept) ? digits.slice(kept.length) : `+${digits}`, { delay: 25 })
  return (await value()).replace(/\D/g, '')
}

/**
 * WhatsApp's own way, on its page: { code } or { error, refused }.
 * step(text): said on the page and kept in the log.
 */
export async function codeFromButtons(page, digits, step = () => {}, { waitMs = 30_000 } = {}) {
  let code = await readCode(page)
  if (code) return { code }
  let box = (await pageState(page))?.box ? await page.waitForSelector(BOX, { visible: true, timeout: 3000 }).catch(() => null) : null
  // A page just loaded may not take the click yet: pressed again a few times.
  for (let i = 0; !box && i < 4; i++) {
    if (!i) step('Pressing "Log in with phone number" on WhatsApp\'s page…')
    if (!(await page.evaluate(clickPhoneLink).catch(() => false))) return { error: 'WhatsApp\'s page has no "Log in with phone number" button (WhatsApp changed its page?).' }
    box = await page.waitForSelector(BOX, { visible: true, timeout: 4000 }).catch(() => null)
  }
  if (!box) return { error: 'WhatsApp\'s page did not show its phone number box.' }
  step(`Typing the number (${masked(digits)}) on WhatsApp's page…`)
  const typed = await typeNumber(page, box, digits)
  if (typed !== digits) return { error: `WhatsApp's box took the number as +${masked(typed)}, not +${masked(digits)}.` }
  step('Pressing Next…')
  if (!(await page.evaluate(clickNext).catch(() => false))) return { error: 'WhatsApp\'s page has no Next button.' }
  step('Waiting for WhatsApp\'s code…')
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await sleep(700)
    code = await readCode(page)
    if (code) return { code }
    const no = await page.evaluate(refusalIn).catch(() => '')
    if (no) return { error: `WhatsApp refused the number: ${no}`, refused: true }
  }
  return { error: 'WhatsApp did not show a code after Next (slow internet?).' }
}

// ------------------------------------------------------- the log to Adal --
/**
 * "Send this PC's WhatsApp log": the link steps (numbers masked, no messages) to Adal —
 * this PC's own keep_meta row "/_support/whatsapp-link" (Admin reads it), and a Help
 * ticket with the PC's logs when the tower is open for this PC.
 */
export async function sendLinkLog(db, key, state, { cloudOf = null, ticket = null } = {}) {
  const data = {
    at: new Date().toISOString(), pc_name: os.hostname().slice(0, 60), key,
    state: { status: state?.status || null, step: state?.step || null, error: state?.error || null },
    steps: linkLog(key),
  }
  const out = { sent: false, ticket: false }
  try {
    const C = cloudOf ? await cloudOf() : await import('./chatCloud.js')
    if (!C.chatConfigured()) throw new Error('this PC has no online account')
    const me = await C.cloudAgencyId(db)
    if (!me) throw new Error('this PC is not signed in online')
    await C.cloudCall(db, 'POST', '/rest/v1/keep_meta?on_conflict=agency_id,key',
      [{ agency_id: me, key: '/_support/whatsapp-link', data, updated_at: data.at }], { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })
    out.sent = true
  } catch (e) { out.error = e.message }
  try {
    const T = ticket ? { createTicket: ticket } : await import('./tower.js')
    const text = `WhatsApp link log (${data.pc_name}): ${data.state.status}${data.state.error ? ` — ${data.state.error}` : ''}\n` + data.steps.map(s => `${s.at.slice(11, 19)} ${s.step}${s.error ? ` — ${s.error}` : ''}`).join('\n')
    await T.createTicket(db, { text, page: '/whatsapp' })
    out.ticket = true
  } catch {}
  if (!out.sent && !out.ticket) throw Object.assign(new Error(`Not sent: ${out.error || 'no internet'}`), { status: 503 })
  return out
}
