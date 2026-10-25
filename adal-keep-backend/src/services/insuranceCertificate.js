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
import { visaNames, markField, setText, setSelect, clickText } from './mofaVisa.js'

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
    phone: String(p.phone_number || '').trim(),
    email: settings.agency_email || '',
    woreda: '',
    sub_city: String(p.zone_subcity || '').trim(),
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

/** Sets a date box (the browser's own date input takes yyyy-mm-dd). */
function setDate(page, key, iso) {
  return page.evaluate((key, iso) => {
    const el = document.querySelector(`[data-adal-v="${key}"]`)
    if (!el || !iso) return ''
    const [y, m, d] = iso.split('-')
    const v = el.type === 'date' ? iso : `${m}/${d}/${y}`
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    el.blur()
    return el.value
  }, key, iso)
}

async function fillCertificate(page, ctx, v) {
  const left = []
  const select = async (label, key, src, name = label) => {
    if (!(await markField(page, label, key, 'select'))) return left.push(name)
    if (!src) return left.push(name)
    const r = await setSelect(page, key, src, ctx)
    if (r.ok) { log(ctx, `✓ ${name}: ${r.text}`); await sleep(500) }
    else left.push(`${name}${r.options?.length ? ` (choices: ${r.options.slice(0, 8).join(', ')})` : ''}`)
  }
  const text = async (label, key, value, name = label) => {
    if (!(await markField(page, label, key, 'input, textarea'))) return left.push(name)
    const cur = await page.$eval(`[data-adal-v="${key}"]`, e => e.value).catch(() => '')
    if (cur) return log(ctx, `${name} already filled — kept`)
    if (!value) return left.push(name)
    if (await setText(page, key, value)) log(ctx, `✓ ${name}: ${value}`)
    else left.push(name)
  }

  await select('insurance branch', 'branch', v.branch, `Insurance Branch${v.branchName ? '' : ' (set it in Settings → Insurance)'}`)
  await text('number of insured', 'insured', v.insured, 'Number Of Insured')
  log(ctx, '✍️ Add Insured')
  await select('title', 'title', v.title, 'Title')
  await text('first name', 'first', v.first, 'First Name')
  await text('father name', 'father', v.father, 'Father Name')
  await text('grand ?father name', 'gfather', v.grandfather, 'Grand Father Name')
  await select('gender', 'gender', v.gender, 'Gender')
  if (await markField(page, 'date of birth', 'dob', 'input')) {
    const got = await setDate(page, 'dob', v.dob)
    if (got) log(ctx, `✓ Date Of Birth: ${got}`); else left.push('Date Of Birth')
  } else left.push('Date Of Birth')
  await text('passport (?:number|no\\.?)', 'passport', v.passport, 'Passport Number')
  await text('labou?r id', 'labor', v.labor_id, 'Labor ID')
  await text('phone', 'phone', v.phone, 'Phone')
  await text('e-?mail', 'email', v.email, 'Email')
  await text('woreda', 'woreda', v.woreda, 'Woreda')
  await text('sub ?city', 'subcity', v.sub_city, 'Sub City')
  await select('region', 'region', v.region, 'Region')
  await select('country of destination', 'dest', v.destination, 'Country Of Destination')
  return left
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
  log(ctx, 'New Certificate')
  await clickText(page, /^\s*\+?\s*new certificate\s*$/)
  if (!(await until(async () => /add insured/i.test(await page.evaluate(() => document.body?.innerText || '')) && !!(await page.$('input')), 30000, ctx))) {
    throw new Error('The New Certificate form did not open')
  }
  await sleep(1000)
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
