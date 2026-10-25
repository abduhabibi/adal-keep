/**
 * insuranceCertificate.js — "Insurance certificate" on FetaP, Nyala
 * Insurance's agency platform (agency.niscofetap.com). Workflow id:
 * insurance_certificate.
 *
 *   1. Sign in with the insurance account (one for every run). Anything the
 *      sign-in asks besides the name and password (a code, a captcha) is a
 *      person's: the tab comes to the front and rings.
 *   2. Certificate → Draft Certificates (/certificate/draft) → New Certificate.
 *   3. The form: Insurance Branch (Settings → Insurance), Number Of Insured 1,
 *      Title, First / Father / Grand Father Name, Gender, Date Of Birth,
 *      Passport Number, Labor ID, Phone, Email (agency), Sub City, Region
 *      Addis Ababa, Country Of Destination.
 *   4. A person checks it and finishes it (Add Member, beneficiary, save /
 *      pay): Adal Keep rings with the insurance sound and waits.
 */
import { signInTurn } from './tabManager.js'
import { visaNames, clickText } from './mofaVisa.js'

export const INSURANCE_CERTIFICATE = 'insurance_certificate'
const HOME = 'https://agency.niscofetap.com/'
const DRAFT_URL = 'https://agency.niscofetap.com/certificate/draft'
const LOGIN_WAIT_MS = 10 * 60 * 1000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = (ctx) => typeof ctx?.isCancelled === 'function' && ctx.isCancelled()

function log(ctx, msg, level = 'info') {
  if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
  console.log(`[insurance] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}

async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    if (await test().catch(() => false)) return true
    await sleep(500)
  }
  return false
}

const isoDate = (v) => {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return s && !isNaN(d) ? d.toISOString().slice(0, 10) : ''
}

/** What the certificate form gets. Choices are regular expressions. */
export function insuranceValues(profile, settings = {}) {
  const p = profile || {}
  const n = visaNames(p)
  const g = String(p.gender || '').trim().toUpperCase()
  const dest = String(p.destination_country || '').trim()
  return {
    branch: settings.insurance_branch ? `^\\s*${settings.insurance_branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$` : '',
    branchName: settings.insurance_branch || '',
    insured: '1',
    title: g.startsWith('F') ? '^\\s*ms\\.?\\s*$' : g.startsWith('M') ? '^\\s*mr\\.?\\s*$' : '',
    first: n.first,
    father: n.father,
    grandfather: [n.grandfather, n.family].filter(Boolean).join(' '),
    gender: g.startsWith('F') ? '^\\s*female' : g.startsWith('M') ? '^\\s*male' : '',
    dob: isoDate(p.date_of_birth),
    passport: String(p.passport_number || '').trim().toUpperCase().replace(/\s+/g, ''),
    labor_id: String(p.labor_id || '').trim(),
    // Local form: 0911544555 (profiles may keep 251911544555 or +251…).
    phone: (() => { const d = String(p.phone_number || '').replace(/\D/g, ''); return d.startsWith('251') ? `0${d.slice(3)}` : d.length === 9 ? `0${d}` : d })(),
    email: settings.agency_email || '',
    // Her own sub city when the profile has one, else the one chosen in Settings → Insurance.
    woreda: settings.insurance_woreda || '',
    sub_city: String(p.zone_subcity || '').trim() || settings.insurance_sub_city || '',
    region: 'addis',
    destination: dest ? dest.split(/\s+/)[0].toLowerCase() : 'saudi',
  }
}

/** What the run cannot do without. */
export function missingForInsurance(v) {
  const need = { first: 'name', father: "father's name", gender: 'gender', dob: 'date of birth', passport: 'passport number' }
  return Object.entries(need).filter(([k]) => !v[k]).map(([, label]) => label)
}

const hasPassword = (page) => page.evaluate(() => [...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null)).catch(() => false)

/** Name and password into the sign-in form; true when it can be sent as it is. */
function fillLogin(page, ctx) {
  return page.evaluate((user, pass) => {
    const seen = (e) => e.offsetParent !== null
    const pw = [...document.querySelectorAll('input[type="password"]')].find(seen)
    if (!pw) return { ok: false }
    const before = [...document.querySelectorAll('input')].filter(i => seen(i) && /^(text|email|tel|)$/i.test(i.type) && (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING))
    const name = before.pop()
    const set = (el, v) => {
      if (!el || el.value) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    }
    set(name, user); set(pw, pass)
    // Something else to type (a code, a captcha) or a robot check: a person's.
    const extra = [...document.querySelectorAll('input')].some(i => seen(i) && /^(text|tel|number|)$/i.test(i.type) && (pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) && !i.value)
    const robot = [...document.querySelectorAll('iframe')].some(f => /recaptcha|hcaptcha|turnstile/i.test(f.src))
    return { ok: !!(name?.value && pw.value), extra: extra || robot }
  }, ctx.insurance_username, ctx.insurance_password)
}

async function signIn(page, ctx) {
  const release = await signInTurn('insurance')
  try {
    log(ctx, 'opening FetaP (agency.niscofetap.com)')
    await page.goto(DRAFT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    await sleep(2500)
    if (!(await hasPassword(page))) { log(ctx, '✓ already signed in to FetaP'); return }
    if (!ctx.insurance_username || !ctx.insurance_password) throw new Error('No insurance account — add one under AI Actions → Insurance login account')
    const f = await fillLogin(page, ctx)
    if (f.ok && !f.extra) {
      log(ctx, `🔐 signing in as ${ctx.insurance_name || ctx.insurance_username}`)
      await clickText(page, /^\s*(log ?in|sign ?in|login)\s*$/)
    } else {
      await page.bringToFront().catch(() => {})
      await ctx.notify(`🛡 ${ctx.profileName}: insurance sign-in needs you`, 'The FetaP tab is in front with the name and password filled. Finish the sign-in; Adal Keep continues by itself.', 'warn')
    }
    const t0 = Date.now()
    let asked = f.extra
    while (Date.now() - t0 < LOGIN_WAIT_MS) {
      if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
      await sleep(2000)
      if (!(await hasPassword(page))) break
      if (!asked && Date.now() - t0 > 15000) {
        asked = true
        await page.bringToFront().catch(() => {})
        await ctx.notify(`🛡 ${ctx.profileName}: insurance sign-in needs you`, 'FetaP is still on its sign-in page. Finish the sign-in in that tab; Adal Keep continues by itself.', 'warn')
      }
    }
    if (await hasPassword(page)) throw new Error('Nobody signed in to FetaP within 10 minutes')
    log(ctx, '✓ signed in to FetaP')
  } finally { release() }
}

/**
 * FetaP's form (a Vue modal, .modal-parent): every text box is named by its
 * placeholder, every list by its first option ("Title", "Gender", "Region"…),
 * the two date boxes are, in order, Date Of Birth and Effective Date.
 */
function fillBox(page, placeholder, value) {
  return page.evaluate((ph, v) => {
    const root = document.querySelector('.modal-parent') || document
    const el = [...root.querySelectorAll('input, textarea')].find(i => (i.placeholder || '').trim().toLowerCase() === ph.toLowerCase() && i.offsetParent !== null)
    if (!el) return 'missing'
    if (el.value) return 'kept'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    el.focus()
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    el.blur()
    return el.value === v ? 'ok' : 'failed'
  }, placeholder, value)
}

function chooseIn(page, firstOption, src) {
  return page.evaluate((first, src) => {
    const root = document.querySelector('.modal-parent') || document
    const el = [...root.querySelectorAll('select')].find(s => (s.options[0]?.text || '').trim().toLowerCase() === first.toLowerCase())
    if (!el) return { state: 'missing' }
    const re = new RegExp(src, 'i')
    const o = [...el.options].slice(1).find(o => re.test(o.text.trim()))
    if (!o) return { state: 'no-match', options: [...el.options].slice(1, 10).map(o => o.text.trim()) }
    el.value = o.value
    o.selected = true
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    return { state: el.selectedIndex > 0 ? 'ok' : 'failed', text: o.text.trim() }
  }, firstOption, src)
}

function setDateNth(page, n, iso) {
  return page.evaluate((n, iso) => {
    const root = document.querySelector('.modal-parent') || document
    const el = [...root.querySelectorAll('input[type="date"]')].filter(i => i.offsetParent !== null)[n]
    if (!el || !iso) return ''
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, iso)
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    el.blur()
    return el.value
  }, n, iso)
}

async function fillCertificate(page, ctx, v) {
  const left = []
  const select = async (first, src, name = first) => {
    if (!src) return left.push(name)
    const r = await chooseIn(page, first, src)
    if (r.state === 'ok') { log(ctx, `✓ ${name}: ${r.text}`); await sleep(400) }
    else left.push(`${name}${r.options?.length ? ` (choices: ${r.options.join(', ')})` : ''}`)
  }
  const text = async (placeholder, value, name = placeholder) => {
    if (!value) return left.push(name)
    const r = await fillBox(page, placeholder, value)
    if (r === 'ok') log(ctx, `✓ ${name}: ${value}`)
    else if (r === 'kept') log(ctx, `${name} already filled — kept`)
    else left.push(name)
  }

  await select('Insurance Branch', v.branch, `Insurance Branch${v.branchName ? '' : ' (choose it in Settings → Insurance)'}`)
  await text('Number Of Insured', v.insured)
  log(ctx, '✍️ Add Insured')
  await select('Title', v.title)
  await text('First Name', v.first)
  await text('Father Name', v.father)
  await text('Grand Father Name', v.grandfather)
  await select('Gender', v.gender)
  const dob = await setDateNth(page, 0, v.dob)
  if (dob) log(ctx, `✓ Date Of Birth: ${dob}`); else left.push('Date Of Birth')
  await text('Passport Number', v.passport)
  await text('Labor ID', v.labor_id)
  await text('Phone', v.phone)
  await text('Email', v.email)
  await text('Woreda', v.woreda)
  await text('Sub city', v.sub_city, 'Sub City')
  await select('Region', v.region)
  await select('Country Of Destination', v.destination)
  return left
}

/** "+ New certificate" is a clickable <div>: click it like a person, until the form shows. */
async function openNewCertificate(page, ctx) {
  const formOpen = () => page.evaluate(() => {
    const m = document.querySelector('.modal-parent')
    const first = [...document.querySelectorAll('input')].find(i => i.placeholder === 'First Name')
    return (!m || !m.classList.contains('hidden')) && !!first && first.offsetParent !== null
  })
  for (let attempt = 1; attempt <= 3; attempt++) {
    const h = await page.evaluateHandle(() => {
      const hits = [...document.querySelectorAll('div, span, button, a')]
        .filter(e => /^\s*\+?\s*new certificate\s*$/i.test(e.innerText || '') && e.offsetParent !== null)
      const el = hits[hits.length - 1] // the innermost
      if (!el) return null
      let c = el
      while (c && c.parentElement && getComputedStyle(c).cursor !== 'pointer' && c.tagName !== 'BUTTON') c = c.parentElement
      return getComputedStyle(c).cursor === 'pointer' || c.tagName === 'BUTTON' ? c : el
    })
    const el = h.asElement()
    if (!el) throw new Error('FetaP shows no "+ New certificate" button')
    log(ctx, `+ New certificate${attempt > 1 ? ` (again, ${attempt})` : ''}`)
    await el.click().catch(() => el.evaluate(e => e.click()))
    if (await until(formOpen, 15000, ctx)) return
  }
  throw new Error('The New Certificate form did not open after clicking "+ New certificate"')
}

export async function runInsuranceCertificate(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const v = insuranceValues(ctx.profile, ctx.insurance || {})
  const missing = missingForInsurance(v)
  if (missing.length) return { ok: false, step: 'preflight', error: `Profile is missing for the insurance: ${missing.join(', ')}`, seconds: 0 }

  log(ctx, `🛡 Insurance certificate for ${ctx.profileName}`)
  await signIn(page, ctx)

  if (!/\/certificate\/draft/i.test(page.url())) await page.goto(DRAFT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
  if (!(await until(async () => /new certificate/i.test(await page.evaluate(() => document.body?.innerText || '')), 60000, ctx))) {
    throw new Error('The Draft Certificates page did not show "New Certificate"')
  }
  await openNewCertificate(page, ctx)
  await sleep(800)
  const left = await fillCertificate(page, ctx, v)

  await ctx.noteProfile?.(`Insurance: the FetaP certificate form is filled — waiting for a person${left.length ? ` (also to fill: ${left.join('; ')})` : ''}`)
  await page.bringToFront().catch(() => {})
  await ctx.notify(
    `🛡 ${ctx.profileName}: insurance certificate form filled`,
    (left.length ? `Still to fill: ${left.join('; ')}. ` : 'Everything is filled. ') +
    'In the FetaP tab: check it, press Add Member, add the beneficiary and finish the certificate. Then press "✔️ Insurance done" on the run.',
    'warn'
  )
  if (left.length) log(ctx, `left for a person: ${left.join('; ')}`, 'warn')
  return { ok: true, pauseReason: 'awaiting-insurance-save', seconds: secs() }
}
