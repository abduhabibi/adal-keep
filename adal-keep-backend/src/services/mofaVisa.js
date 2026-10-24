/**
 * mofaVisa.js — "Make visa" on the Saudi visa platform (workflow id: mofa_visa).
 *
 *   1. visa.mofa.gov.sa/Account/Login: Login Name and Password from the visa
 *      platform account (Settings / AI Actions — one account for every run).
 *      A person types the picture captcha and presses Login: the tab comes to
 *      the front and rings (the visa sound). Runs take turns signing in, and
 *      a run whose browser is already signed in skips this.
 *   2. New Application → Add A New Application → Agree (twice).
 *   3. The long form, everything from the profile and her Musaned contract:
 *      visa information, names, personal photo, passport, religion, marital
 *      status, gender, occupation, qualification, KSA address, email, the
 *      sponsor (her employer), transport, entry date, both check boxes.
 *   4. A person types the captcha and presses Save — never Adal Keep. The run
 *      watches for the Save for 15 minutes: then the profile reads
 *      "Visa applied" (with the application number when the page shows one).
 *      Otherwise it waits as "awaiting-visa-save" and "✔️ Visa saved" ends it.
 *
 * Where each profile stands is kept in profiles.visa_stage, so the profile
 * list can filter by it.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { signInTurn } from './tabManager.js'

export const MOFA_VISA = 'mofa_visa'
const LOGIN_URL = 'https://visa.mofa.gov.sa/Account/Login'
const LIST_URL = 'https://visa.mofa.gov.sa/SmartForm'
const LOGIN_WAIT_MS = 10 * 60 * 1000
const SAVE_WAIT_MS = 15 * 60 * 1000

export const VISA_STAGES = {
  waiting: 'Visa form filled — waiting for Save',
  applied: 'Visa applied',
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = (ctx) => typeof ctx?.isCancelled === 'function' && ctx.isCancelled()

function log(ctx, msg, level = 'info') {
  if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
  console.log(`[visa] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}

/** Waits until `test()` is true (checked every 500 ms). */
async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    if (await test().catch(() => false)) return true
    await sleep(500)
  }
  return false
}

const onLogin = (page) => /\/account\/login/i.test(page.url())

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
const isoDate = (v) => {
  if (!v) return ''
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return isNaN(d) ? '' : d.toISOString().slice(0, 10)
}
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

/** "HIWOT GETACHEW ZENEBE" → first HIWOT, father GETACHEW, family ZENEBE. */
export function visaNames(p) {
  const full = String(p.full_name || [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' '))
    .trim().replace(/\s+/g, ' ').toUpperCase()
  const w = full ? full.split(' ') : []
  if (w.length <= 1) return { first: w[0] || '', father: '', grandfather: '', family: String(p.last_name || '').toUpperCase() }
  if (w.length === 2) return { first: w[0], father: '', grandfather: '', family: w[1] }
  return { first: w[0], father: w[1], grandfather: w.slice(2, -1).join(' '), family: w[w.length - 1] }
}

const contractOf = (p) => { try { return JSON.parse(p.contract_data || '{}') || {} } catch { return {} } }

// Saudi airports by the city she works in (Port of Entry).
const PORTS = [
  [/jedd?ah|jidd?ah|makk?ah|mecca|ta'?if|جدة|مكة|الطائف/i, 'jedd?ah|jidd?ah|king abdul ?aziz|جدة'],
  [/riyad|kharj|qass?im|buraid|unaiz|الرياض|الخرج|القصيم/i, 'riyadh|king khalid|الرياض'],
  [/dammam|khobar|dhahran|ahsa|hofuf|qatif|jubail|الدمام|الخبر|الأحساء|القطيف|الجبيل/i, 'dammam|king fahd|الدمام'],
  [/madinah|medina|yanbu|المدينة|ينبع/i, 'madinah|medina|prince moh?amm?ad|المدينة'],
  [/abha|khamis|أبها|خميس/i, 'abha|أبها'],
  [/tabuk|تبوك/i, 'tabuk|تبوك'],
  [/jazan|jizan|جازان/i, 'jazan|jizan|جازان'],
  [/ha'?il\b|حائل/i, "ha'?il|حائل"],
  [/najran|نجران/i, 'najran|نجران'],
]
function portFor(city) {
  const hit = PORTS.find(([re]) => re.test(city || ''))
  return hit ? hit[1] : ''
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Everything the form gets. Choices are regular expressions matched against
 * the dropdown's option text; Settings (visa_*) can name a choice exactly.
 */
export function visaValues(profile, files = {}, settings = {}) {
  const p = profile || {}
  const c = contractOf(p)
  const n = visaNames(p)
  const pick = (setting, fallback) => (settings[setting] ? `^\\s*${esc(settings[setting])}\\s*$` : fallback)
  const rel = String(p.religion || c.Religion || '').toLowerCase()
  const g = String(p.gender || c.Gender || '').trim().toUpperCase()
  const m = String(p.marital_status || c['Marital Status'] || '').trim().toUpperCase()
  const city = p.work_city || c['City of Work'] || p.employer_address || ''
  const address = String(p.employer_address || c.Location || p.work_city || '').trim()
  const travelled = /have|yes/i.test(p.work_experience || '') && String(p.experience_country || '').trim()
  return {
    visa_type: pick('visa_type', 'work|عمل'),
    nationality: 'ethiopia',
    mission: pick('visa_mission', 'addis'),
    entries: pick('visa_entries', 'single|واحدة|مفردة'),
    validity: settings.visa_validity ? pick('visa_validity') : '',
    duration: settings.visa_duration ? pick('visa_duration') : '',
    first: n.first, father: n.father, grandfather: n.grandfather, family: n.family,
    previous_nationality: 'no',
    passport: String(p.passport_number || c['Passport Number'] || '').trim().toUpperCase().replace(/\s+/g, ''),
    passport_type: pick('visa_passport_type', 'normal|ordinary|regular|عادي'),
    issuing_country: 'ethiopia',
    issue_date: isoDate(p.passport_issue_date || c['Passport Issue Date']),
    expiry_date: isoDate(p.passport_expiry_date || c['Passport Expiry Date']),
    birth_place: String(p.place_of_birth || c['Passport Issue Place'] || '').trim().toUpperCase(),
    dob: isoDate(p.date_of_birth || c['Date of Birth']),
    id_number: String(p.national_id || '').trim(),
    religion: !rel ? '' : /muslim|islam/.test(rel) && !/non/.test(rel) ? 'muslim|islam|مسلم' : 'christ|مسيح',
    marital: !m ? '' : m.startsWith('MARRIED') ? '^\\s*married|متزوج' : m.startsWith('DIVORC') ? 'divorc|مطلق' : m.startsWith('WIDOW') ? 'widow|أرمل|ارمل' : 'single|أعزب|عزباء',
    gender: g.startsWith('F') ? 'female|أنثى|انثى' : g.startsWith('M') ? '^\\s*male|ذكر' : '',
    occupation: pick('visa_occupation', 'house ?maid|domestic|housekeeper|عاملة منزلية|خادمة'),
    qualification: settings.visa_qualification || String(p.education_level || c['Education level'] || '').trim() || 'None',
    degree_source: settings.visa_degree_source || 'Ethiopia',
    ksa_address: address,
    email: settings.agency_email || String(c['E-Mail'] || '').trim(),
    sponsor_name: String(p.employer_name || '').trim(),
    sponsor_id: String(p.employer_id || '').trim(),
    sponsor_address: address,
    sponsor_phone: String(p.employer_phone || c['Mobile Number'] || '').replace(/\D/g, ''),
    visa_number: String(p.visa_number || c['Visa Number'] || c['Candidate · Visa Number'] || '').trim(),
    transport: pick('visa_transport', 'air|جو'),
    port: settings.visa_port ? pick('visa_port') : portFor(city),
    city,
    entry_date: addDays(Number(settings.visa_entry_days) || 30),
    purpose: settings.visa_purpose || 'Work',
    travelled: travelled ? 'yes' : 'no',
    travelled_where: travelled || '',
    photoPath: files.photoPath || '',
  }
}

/** What the run cannot do without — said before the visa platform opens. */
export function missingForVisa(v) {
  const need = {
    first: 'name', family: 'surname', passport: 'passport number', issue_date: 'passport issue date',
    expiry_date: 'passport expiry date', dob: 'date of birth', gender: 'gender', sponsor_name: 'employer name (Musaned contract)',
    sponsor_id: 'employer ID (Musaned contract)', photoPath: 'Photo file',
  }
  return Object.entries(need).filter(([k]) => !v[k]).map(([, label]) => label)
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
/** Clicks the visible link/button whose text matches (the last one when `last`). */
async function clickText(page, re, { last = false } = {}) {
  const h = await page.evaluateHandle((src, last) => {
    const re = new RegExp(src, 'i')
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const all = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], li > span')]
      .filter(e => seen(e) && re.test((e.innerText || e.value || '').trim()))
    return (last ? all[all.length - 1] : all[0]) || null
  }, re.source, last)
  const el = h.asElement()
  if (!el) return false
  await el.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {})
  await el.click().catch(async () => { await el.evaluate(e => e.click()) })
  return true
}

/**
 * Marks the control under a label with data-adal-v="<key>": the label's own
 * `for`, else the first input/select/textarea after the label inside the
 * nearest box that has one. Returns the control's kind, or '' when the form
 * does not ask it.
 */
function markField(page, labelSrc, key, kinds = 'input, select, textarea') {
  return page.evaluate((labelSrc, key, kinds) => {
    const re = new RegExp(`^\\s*\\*?\\s*(?:${labelSrc})\\s*\\*?\\s*:?\\s*$`, 'i')
    const own = (e) => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ')
    const labels = [...document.querySelectorAll('label, span, div, td, th, p, strong')]
      .filter(e => re.test(own(e)) || (e.children.length <= 2 && re.test((e.innerText || '').replace(/\s+/g, ' '))))
    const usable = (el) => el && !el.closest('[data-adal-skip]') && !/^(hidden|submit|button|image|file)$/i.test(el.type || '')
    for (const lab of labels) {
      let el = lab.htmlFor ? document.getElementById(lab.htmlFor) : null
      if (!usable(el)) el = null
      for (let box = lab.parentElement, i = 0; !el && box && i < 4; box = box.parentElement, i++) {
        el = [...box.querySelectorAll(kinds)].find(x => usable(x) && (lab.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)) || null
      }
      if (el) {
        el.setAttribute('data-adal-v', key)
        return el.tagName === 'SELECT' ? 'select' : (el.type === 'radio' ? 'radio' : 'text')
      }
    }
    return ''
  }, labelSrc, key, kinds)
}

/** Types a value into a text box (React/jQuery/plain pages all hear it). */
function setText(page, key, value) {
  return page.evaluate((key, v) => {
    const el = document.querySelector(`[data-adal-v="${key}"]`)
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    el.focus()
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    for (const t of ['input', 'change', 'keyup']) el.dispatchEvent(new Event(t, { bubbles: true }))
    if (window.jQuery) window.jQuery(el).trigger('change')
    el.blur()
    return String(el.value).trim() === String(v).trim()
  }, key, value)
}

/** Chooses the option whose text matches; waits for the list to load first. */
async function setSelect(page, key, src, ctx) {
  let opts = []
  await until(async () => {
    opts = await page.evaluate((key) => [...(document.querySelector(`[data-adal-v="${key}"]`)?.options || [])]
      .map(o => o.text.trim()).filter(t => t && !/^-*\s*(select|اختر)/i.test(t)), key)
    return opts.length > 0
  }, 10000, ctx)
  return page.evaluate((key, src) => {
    const el = document.querySelector(`[data-adal-v="${key}"]`)
    if (!el) return { ok: false, options: [] }
    const real = [...el.options].filter(o => o.value && !/^-*\s*(select|اختر)/i.test(o.text.trim()))
    const re = src ? new RegExp(src, 'i') : null
    const o = re ? real.find(o => re.test(o.text.trim())) : (real.length === 1 ? real[0] : null)
    if (!o) return { ok: false, options: real.map(o => o.text.trim()).slice(0, 12) }
    el.value = o.value
    o.selected = true
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (window.jQuery) window.jQuery(el).val(o.value).trigger('change')
    return { ok: el.value === o.value, text: o.text.trim() }
  }, key, src)
}

/** Sets a date box: the page's own date picker when it has one, else dd/mm/yyyy. */
function setDate(page, key, iso) {
  return page.evaluate((key, iso) => {
    const el = document.querySelector(`[data-adal-v="${key}"]`)
    if (!el || !iso) return ''
    const [y, m, d] = iso.split('-').map(Number)
    const date = new Date(y, m - 1, d, 12)
    const $ = window.jQuery
    const pad = (n) => String(n).padStart(2, '0')
    try { if ($ && $(el).data('datepicker')) $(el).datepicker('setDate', date) } catch {}
    try { if ($ && $(el).data('DateTimePicker')) $(el).data('DateTimePicker').date(date) } catch {}
    try { if ($ && $(el).hasClass('hasDatepicker')) $(el).datepicker('setDate', date) } catch {}
    try { if ($ && $(el).hasClass('is-calendarsPicker') && $.calendars) $(el).calendarsPicker('setDate', $.calendars.instance('gregorian').newDate(y, m, d)) } catch {}
    if (!el.value) {
      const fmt = String(el.getAttribute('data-date-format') || el.placeholder || '').toLowerCase()
      const v = /^y/.test(fmt) ? `${y}-${pad(m)}-${pad(d)}` : /^mm/.test(fmt) ? `${pad(m)}/${pad(d)}/${y}` : `${pad(d)}/${pad(m)}/${y}`
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
      if ($) $(el).trigger('change')
    }
    try { if ($) $('.datepicker, .ui-datepicker, .bootstrap-datetimepicker-widget').hide() } catch {}
    return el.value
  }, key, iso)
}

/** Ticks the Yes / No radio that follows a question. */
function setRadio(page, questionSrc, answer) {
  return page.evaluate((src, answer) => {
    const re = new RegExp(src, 'i')
    const q = [...document.querySelectorAll('label, span, div, td, p')]
      .filter(e => re.test(e.innerText || '') && (e.innerText || '').length < 220)
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
    if (!q) return false
    const want = new RegExp(`^\\s*${answer}\\s*$`, 'i')
    const labelOf = (r) => (r.labels?.[0]?.innerText || r.nextSibling?.textContent || r.parentElement?.innerText || r.value || '').trim()
    for (let box = q, i = 0; box && i < 5; box = box.parentElement, i++) {
      const radios = [...box.querySelectorAll('input[type="radio"]')].filter(r => q.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING || q.contains(r))
      const r = radios.find(r => want.test(labelOf(r)) || want.test(r.value))
      if (r) {
        r.click()
        if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })) }
        return r.checked
      }
    }
    return false
  }, questionSrc, answer)
}

/** Ticks the check box whose text matches. */
function tick(page, src) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    for (const c of document.querySelectorAll('input[type="checkbox"]')) {
      // Its own words: its label, the text right after it, or a parent that holds only this box.
      const solo = c.parentElement && c.parentElement.querySelectorAll('input[type="checkbox"]').length === 1
      const text = `${c.labels?.[0]?.innerText || ''} ${c.nextSibling?.textContent || ''} ${c.nextElementSibling?.innerText || ''} ${solo ? c.parentElement.innerText : ''}`
      if (!re.test(text)) continue
      if (!c.checked) c.click()
      if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) }
      return c.checked
    }
    return false
  }, src)
}

/** The personal photo as a small JPEG (the platform takes pictures, not PDFs). */
async function photoJpeg(src, runId) {
  try {
    const sharp = (await import('sharp')).default
    const out = path.join(os.tmpdir(), `adal-visa-photo-${runId || Date.now()}.jpg`)
    for (const q of [88, 75, 60, 45]) {
      const buf = await sharp(src).rotate().resize({ width: 480, height: 600, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: q }).toBuffer()
      fs.writeFileSync(out, buf)
      if (buf.length <= 100 * 1024) break
    }
    return out
  } catch { return src }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
/** Login Name and Password into the sign-in form (when they are empty). */
async function fillLogin(page, ctx) {
  return page.evaluate((user, pass) => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 }
    const pw = [...document.querySelectorAll('input[type="password"]')].find(seen)
    if (!pw) return 'no-form'
    const inputs = [...document.querySelectorAll('input')].filter(i => seen(i) && /^(text|email|)$/i.test(i.type))
    const name = inputs.filter(i => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
    const set = (el, v) => {
      if (!el || el.value) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }))
    }
    set(name, user)
    set(pw, pass)
    // The captcha box: the text box after the password.
    const cap = inputs.find(i => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)
    if (cap && !cap.value) cap.focus()
    return name && name.value && pw.value ? 'filled' : 'partly'
  }, ctx.visa_username, ctx.visa_password)
}

async function signIn(page, ctx) {
  const release = await signInTurn('mofa')
  try {
    log(ctx, 'opening the visa platform')
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
      .catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    await sleep(1500)
    if (!onLogin(page) && !(await page.$('input[type="password"]'))) {
      log(ctx, '✓ already signed in to the visa platform (shared sign-in)')
      return
    }
    if (!onLogin(page)) await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    if (!ctx.visa_username || !ctx.visa_password) {
      throw new Error('No visa platform account — add one under AI Actions → Visa platform login account')
    }
    await page.waitForSelector('input[type="password"]', { timeout: 60000 })
    await fillLogin(page, ctx)
    log(ctx, `🔐 Login Name and Password filled (${ctx.visa_name || ctx.visa_username}) — a person types the captcha and presses Login`)
    await page.bringToFront().catch(() => {})
    await ctx.notify(
      `🛂 ${ctx.profileName}: visa platform — type the captcha`,
      'The visa platform tab is in front with the Login Name and Password filled. Type the captcha picture\'s numbers and press Login; Adal Keep continues by itself.',
      'warn'
    )
    const t0 = Date.now()
    while (Date.now() - t0 < LOGIN_WAIT_MS) {
      if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
      if (!onLogin(page) && !(await page.$('input[type="password"]').catch(() => null))) break
      // A wrong captcha reloads the form empty: fill it again.
      await fillLogin(page, ctx).catch(() => {})
      await sleep(2000)
    }
    if (onLogin(page)) throw new Error('Nobody signed in to the visa platform within 10 minutes')
    log(ctx, '✓ signed in to the visa platform')
  } finally { release() }
}

/** New Application → Add A New Application → Agree, Agree → the form. */
async function openForm(page, ctx) {
  log(ctx, 'New Application')
  if (!(await clickText(page, /^new application$/))) {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
  }
  if (!(await until(async () => /add a new application/i.test(await page.evaluate(() => document.body?.innerText || '')), 60000, ctx))) {
    if (onLogin(page)) throw new Error('The visa platform signed out')
    throw new Error('The visa application list did not open')
  }
  log(ctx, 'Add A New Application')
  await clickText(page, /add a new application/)
  for (let i = 1; i <= 3; i++) {
    const at = await until(async () => /traditionalapp/i.test(page.url()) || /\bagree\b/i.test(await page.evaluate(() =>
      [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"]')].map(b => b.innerText || b.value).join('|'))), 60000, ctx)
    if (!at) throw new Error('The agreement page did not open')
    if (/traditionalapp/i.test(page.url())) break
    await sleep(800)
    log(ctx, `Agree (${i})`)
    await page.evaluate(() => { window.__adalBefore = 1 }).catch(() => {})
    if (!(await clickText(page, /^\s*(i )?agree\s*$/))) throw new Error('The Agree button was not found')
    // The next page has loaded once the old page's mark is gone.
    await until(async () => /traditionalapp/i.test(page.url()) || !(await page.evaluate(() => window.__adalBefore === 1)), 60000, ctx)
    await sleep(1000)
  }
  const ok = await until(async () => /passport number/i.test(await page.evaluate(() => document.body?.innerText || '')), 90000, ctx)
  if (!ok) throw new Error('The visa application form did not open after Agree')
  await sleep(1500)
  log(ctx, '✓ the visa application form is open')
}

/** Fills the long form. Returns what is still for a person to fill. */
async function fillForm(page, ctx, v) {
  const left = []
  const select = async (label, key, src, name = label) => {
    const kind = await markField(page, label, key, 'select')
    if (!kind) return
    const r = await setSelect(page, key, src, ctx)
    if (r.ok) { log(ctx, `✓ ${name}: ${r.text}`); await sleep(700) }
    else left.push(`${name}${r.options?.length ? ` (choices: ${r.options.slice(0, 6).join(', ')})` : ''}`)
  }
  const text = async (label, key, value, name = label) => {
    if (!(await markField(page, label, key, 'input, textarea'))) return
    const cur = await page.$eval(`[data-adal-v="${key}"]`, e => e.value).catch(() => '')
    if (cur) return log(ctx, `${name} already filled — kept`)
    if (!value) return left.push(name)
    if (await setText(page, key, value)) log(ctx, `✓ ${name}: ${value}`)
    else left.push(name)
  }
  const date = async (label, key, iso, name = label) => {
    if (!(await markField(page, label, key, 'input'))) return
    if (!iso) return left.push(name)
    const got = await setDate(page, key, iso)
    if (got) log(ctx, `✓ ${name}: ${got}`)
    else left.push(name)
  }

  // Visa information (each choice may load the next list).
  log(ctx, '✍️ Visa information')
  await select('visa type', 'vtype', v.visa_type, 'Visa Type')
  await sleep(1200)
  await select('current nationality', 'cnat', v.nationality, 'Current Nationality')
  await sleep(1000)
  await select('nearest saudi mission', 'mission', v.mission, 'Nearest Saudi Mission')
  await select('number of entries', 'entries', v.entries, 'Number of Entries')
  await select('visa validity', 'validity', v.validity, 'Visa Validity')
  await select('duration of stay', 'duration', v.duration, 'Duration Of Stay')
  if (v.visa_number) await text('visa (?:no\\.?|number)', 'vnum', v.visa_number, 'Visa Number')

  // Personal information.
  log(ctx, '✍️ Personal information')
  await text('(?:last|family|last ?/ ?family) name', 'family', v.family, 'Last/Family Name')
  await text('first name', 'first', v.first, 'First Name')
  if (v.father) await text('(?:second ?/ ?father|father|second) name', 'father', v.father, 'Second/Father Name')
  if (v.grandfather) await text('(?:other ?/ ?g\\.? ?father|grand ?father|other) name', 'gfather', v.grandfather, 'Other/G.Father Name')

  // Personal photo.
  if (v.photoPath && fs.existsSync(v.photoPath)) {
    const jpg = await photoJpeg(v.photoPath, ctx.runId)
    const input = (await page.evaluateHandle(() => {
      const files = [...document.querySelectorAll('input[type="file"]')]
      return files.find(f => /image|jpe?g|png/i.test(f.accept || '')) || files[0] || null
    })).asElement()
    if (input) {
      await input.uploadFile(jpg)
      await input.evaluate(e => { e.dispatchEvent(new Event('change', { bubbles: true })); if (window.jQuery) window.jQuery(e).trigger('change') })
      await sleep(1500)
      log(ctx, '✓ Personal photo chosen')
    } else left.push('Personal photo (Select Image)')
  } else left.push('Personal photo (no Photo file on the profile)')

  await setRadio(page, 'do you have previous nationality', v.previous_nationality)
    .then(ok => ok ? log(ctx, '✓ Previous nationality: No') : left.push('Previous nationality (Yes/No)'))

  log(ctx, '✍️ Passport')
  await text('passport (?:no\\.?|number)', 'pnum', v.passport, 'Passport Number')
  await select('passport type', 'ptype', v.passport_type, 'Passport Type')
  await select('issuing country', 'pcountry', v.issuing_country, 'Issuing Country')
  await date('date of issue', 'pissue', v.issue_date, 'Date of Issue')
  await date('date of expiry', 'pexpiry', v.expiry_date, 'Date of Expiry')
  await text('place of birth', 'pob', v.birth_place, 'Place of Birth')
  await date('date of birth', 'dob', v.dob, 'Date of Birth')
  if (v.id_number) await text('id number', 'idnum', v.id_number, 'ID Number')

  await select('religion', 'religion', v.religion, 'Religion')
  await select('marital status', 'marital', v.marital, 'Marital Status')
  await select('gender', 'gender', v.gender, 'Gender')
  await select('occupation', 'occupation', v.occupation, 'Occupation')
  await text('qualification', 'qual', v.qualification, 'Qualification')
  await text('source of degree', 'degree', v.degree_source, 'Source of Degree')
  await text('ksa home address', 'ksaaddr', v.ksa_address, 'KSA Home Address')
  await text('e-?mail(?: address)?', 'email', v.email, 'Email Address')

  // Sponsor = her employer on the Musaned contract.
  log(ctx, '✍️ Sponsor information')
  await text('sponsor name', 'sname', v.sponsor_name, 'Sponsor Name')
  await text('sponsor id (?:no\\.?|number)', 'sid', v.sponsor_id, 'Sponsor ID Number')
  await text('sponsor address', 'saddr', v.sponsor_address, 'Sponsor Address')
  await text('phone (?:no\\.?|number)', 'sphone', v.sponsor_phone, 'Phone Number')
  await select('transport mode', 'transport', v.transport, 'Transport Mode')
  await select('port of entry', 'port', v.port, `Port of Entry${v.city ? ` (works in ${v.city})` : ''}`)
  await date('expected entry date to ksa', 'entry', v.entry_date, 'Expected Entry Date To KSA')
  await text('purpose', 'purpose', v.purpose, 'Purpose')

  const travelled = await setRadio(page, 'have you ever traveled to other countries', v.travelled)
  if (travelled) log(ctx, `✓ Travelled in the last five years: ${v.travelled === 'yes' ? `Yes (${v.travelled_where})` : 'No'}`)
  else left.push('Travelled to other countries in the last five years (Yes/No)')
  if (travelled && v.travelled === 'yes') {
    await sleep(800)
    // The box that opens for "please clarify it".
    const done = await page.evaluate((where) => {
      const q = [...document.querySelectorAll('label, span, div, td, p')].find(e => /have you ever traveled/i.test(e.innerText || '') && (e.innerText || '').length < 220)
      for (let box = q, i = 0; box && i < 4; box = box.parentElement, i++) {
        const t = [...box.querySelectorAll('input[type="text"], textarea')].find(x => x.offsetParent !== null && !x.value)
        if (t) {
          const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(t, where)
          t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }
      }
      return false
    }, v.travelled_where)
    if (!done) left.push(`Which countries she travelled to (${v.travelled_where})`)
  }

  if (await tick(page, 'hereby declare')) log(ctx, '✓ "I hereby declare…" ticked'); else left.push('"I hereby declare…" check box')
  if (await tick(page, 'agree to privacy policy')) log(ctx, '✓ "I agree to Privacy Policy" ticked'); else left.push('"I agree to Privacy Policy" check box')
  return left
}

/** The application number the page shows after Save, if any. */
async function readApplicationNumber(page) {
  return page.evaluate(() => {
    const t = document.body?.innerText || ''
    const m = t.match(/application\s*(?:no\.?|number)\D{0,40}(\d{6,})/i) || t.match(/رقم الطلب\D{0,40}(\d{6,})/)
    return m ? m[1] : ''
  }).catch(() => '')
}

/**
 * After the person presses Save: the platform leaves the form (or shows the
 * application number). Returns the number ('' when it showed none), or null
 * when nobody saved within the wait.
 */
async function waitForSave(page, ctx, passport) {
  const end = Date.now() + SAVE_WAIT_MS
  while (Date.now() < end) {
    if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    let url = ''
    try { url = page.url() } catch { return null }
    if (!/traditionalapp/i.test(url) && !onLogin(page) && /visa\.mofa\.gov\.sa/i.test(url)) {
      const number = await readApplicationNumber(page)
      if (number) return number
      // Back on the list: her row (by passport number) carries the application number.
      const row = await page.evaluate((pp) => {
        const tr = [...document.querySelectorAll('tr')].find(r => pp && (r.innerText || '').toUpperCase().includes(pp))
        return tr ? ((tr.innerText || '').match(/\b\d{6,}\b/) || [''])[0] : null
      }, passport).catch(() => null)
      if (row !== null) return row
    }
    await sleep(3000)
  }
  return null
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
export async function runMofaVisa(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const v = visaValues(ctx.profile, { photoPath: ctx.photoPath }, ctx.visa || {})
  const missing = missingForVisa(v)
  if (missing.length) return { ok: false, step: 'preflight', error: `Profile is missing for the visa: ${missing.join(', ')}`, seconds: 0 }

  log(ctx, `🛂 Visa application for ${ctx.profileName}`)
  await signIn(page, ctx)
  await openForm(page, ctx)
  const left = await fillForm(page, ctx, v)

  // Leave the captcha box ready for the person.
  await page.evaluate(() => {
    const lab = [...document.querySelectorAll('label, span, div, td')].find(e => /^\s*\*?\s*captcha\s*\*?\s*$/i.test(e.innerText || ''))
    let box = lab?.parentElement, input = null
    for (let i = 0; i < 3 && box && !input; i++, box = box.parentElement) input = box.querySelector('input[type="text"], input:not([type])')
    if (input) { input.scrollIntoView({ block: 'center' }); input.focus() }
  }).catch(() => {})

  await ctx.noteProfile?.(`Visa: form filled — waiting for a person to type the captcha and press Save${left.length ? ` (also to fill: ${left.join('; ')})` : ''}`, { visa_stage: VISA_STAGES.waiting })
  await page.bringToFront().catch(() => {})
  await ctx.notify(
    `🛂 ${ctx.profileName}: visa form filled — type the captcha and press Save`,
    (left.length ? `Still to fill: ${left.join('; ')}. ` : 'Every field is filled. ') +
    'Look the form over, type the captcha and press Save in the visa platform tab.',
    'warn'
  )
  if (left.length) log(ctx, `left for a person: ${left.join('; ')}`, 'warn')
  log(ctx, '⏳ waiting for the person to press Save (up to 15 minutes)')

  const number = await waitForSave(page, ctx, v.passport)
  if (number === null) {
    log(ctx, 'Save not seen yet — the run waits; press "✔️ Visa saved" when it is done', 'warn')
    return { ok: true, pauseReason: 'awaiting-visa-save', seconds: secs() }
  }
  await ctx.noteProfile?.(`Visa applied on the visa platform${number ? ` — application number ${number}` : ''}`, {
    visa_stage: VISA_STAGES.applied,
    visa_applied_at: new Date().toISOString(),
    ...(number ? { visa_application_number: number } : {}),
  })
  log(ctx, `✅ visa application saved${number ? ` — application number ${number}` : ''}`)
  return { ok: true, done: true, seconds: secs() }
}
