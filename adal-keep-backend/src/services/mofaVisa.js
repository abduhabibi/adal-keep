/**
 * mofaVisa.js — "Make visa" on the Saudi visa platform (workflow id: mofa_visa).
 *
 *   1. visa.mofa.gov.sa/Account/Login/enjazcompany: Login Name and Password from the visa
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
import { signInTurn, toEnglish } from './tabManager.js'

export const MOFA_VISA = 'mofa_visa'
const LOGIN_URL = 'https://visa.mofa.gov.sa/Account/Login/enjazcompany'
const LIST_URL = 'https://visa.mofa.gov.sa/SmartForm'
const LOGIN_WAIT_MS = 30 * 60 * 1000
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
  // its own day, not the UTC one ("12 MAR 2023" was read as the 11th in Addis)
  return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
    visa_type: pick('visa_type', '^\\s*(work|عمل)\\s*$'),
    nationality: 'ethiopia',
    mission: pick('visa_mission', 'addis'),
    entries: pick('visa_entries', 'single|واحدة|مفردة'),
    validity: pick('visa_validity', '^\\s*90\\b|^\\s*٩٠'),     // 90 Days
    duration: pick('visa_duration', '^\\s*90\\b|^\\s*٩٠'),     // 90
    first: n.first, father: n.father, grandfather: n.grandfather, family: n.family,
    previous_nationality: 'no',
    passport: String(p.passport_number || c['Passport Number'] || '').trim().toUpperCase().replace(/\s+/g, ''),
    passport_type: 'normal|ordinary|regular|عادي',                // always Normal
    issuing_country: 'ethiopia',
    issue_date: isoDate(p.passport_issue_date || c['Passport Issue Date']),
    expiry_date: isoDate(p.passport_expiry_date || c['Passport Expiry Date']),
    birth_place: String(p.place_of_birth || c['Passport Issue Place'] || '').trim().toUpperCase(),
    dob: isoDate(p.date_of_birth || c['Date of Birth']),
    id_number: '0',                                                 // always 0
    religion: !rel ? '' : /muslim|islam/.test(rel) && !/non/.test(rel) ? 'muslim|islam|مسلم' : 'christ|مسيح',
    marital: !m ? '' : m.startsWith('MARRIED') ? '^\\s*married|متزوج' : m.startsWith('DIVORC') ? 'divorc|مطلق' : m.startsWith('WIDOW') ? 'widow|أرمل|ارمل' : 'single|أعزب|عزباء',
    gender: g.startsWith('F') ? 'female|أنثى|انثى' : g.startsWith('M') ? '^\\s*male|ذكر' : '',
    occupation: pick('visa_occupation', 'house ?work|house ?maid|domestic|housekeeper|عاملة منزلية|خادمة'),
    qualification: settings.visa_qualification || String(p.education_level || c['Education level'] || '').trim() || 'None',
    degree_source: '0',                                             // always 0
    ksa_address: address,
    email: settings.agency_email || String(c['E-Mail'] || '').trim(),
    sponsor_name: String(p.employer_name || '').trim(),
    sponsor_id: String(p.employer_id || '').trim(),
    sponsor_address: address,
    sponsor_phone: String(p.employer_phone || c['Mobile Number'] || '').replace(/\D/g, ''),
    visa_number: String(p.visa_number || c['Visa Number'] || c['Candidate · Visa Number'] || '').trim(),
    transport: pick('visa_transport', 'air|جو'),
    port: '',                                                       // Port of Entry: left empty
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
    sponsor_id: 'employer ID (Musaned contract)', photoPath: 'Photo file', religion: 'religion',
  }
  return Object.entries(need).filter(([k]) => !v[k]).map(([, label]) => label)
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
/** Clicks the visible link/button whose text matches (the last one when `last`). */
export async function clickText(page, re, { last = false } = {}) {
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
export function markField(page, labelSrc, key, kinds = 'input, select, textarea') {
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
export function setText(page, key, value) {
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
export async function setSelect(page, key, src, ctx) {
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

/**
 * A list that stays empty until something is typed (a searchable dropdown,
 * Select2 / Chosen): open it, type the word, choose the match. { ok, text } or
 * { ok: false, why } (what kind of box it was, for the log).
 */
export async function typeInSelect(page, key, word, src) {
  const box = await page.evaluate((key) => {
    const el = document.querySelector(`[data-adal-v="${key}"]`)
    if (!el) return null
    const near = el.nextElementSibling
    const s2 = near && /select2|chosen/i.test(near.className) ? near : el.parentElement?.querySelector('.select2-container, .select2, .chosen-container')
    if (!s2) return { kind: `${el.tagName.toLowerCase()}#${el.id || el.name || '?'}${el.disabled ? ' (disabled)' : ''}` }
    s2.setAttribute('data-adal-s2', key)
    return { kind: 'select2' }
  }, key)
  if (!box) return { ok: false, why: 'not found' }
  if (box.kind !== 'select2') return { ok: false, why: box.kind }
  await page.click(`[data-adal-s2="${key}"] .select2-selection, [data-adal-s2="${key}"] .chosen-single, [data-adal-s2="${key}"]`).catch(() => {})
  await sleep(500)
  const search = await page.$('.select2-container--open .select2-search__field, .select2-drop-active input, .chosen-with-drop input')
  if (search) await search.type(word, { delay: 60 })
  const re = new RegExp(src, 'i')
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const hit = await page.evaluateHandle((src) => {
      const re = new RegExp(src, 'i')
      return [...document.querySelectorAll('.select2-results__option, .select2-result-label, .chosen-results li')].find(o => re.test(o.textContent.trim())) || null
    }, src)
    const el = hit.asElement?.()
    if (el) {
      const text = (await el.evaluate(e => e.textContent.trim())) || word
      await el.click().catch(() => el.evaluate(e => e.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))))
      await sleep(400)
      const ok = await page.evaluate((key, src) => { const s = document.querySelector(`[data-adal-v="${key}"]`); const o = s?.options?.[s.selectedIndex]; return !!o && new RegExp(src, 'i').test(o.text) }, key, src).catch(() => false)
      return { ok: ok || re.test(text), text }
    }
  }
  await page.keyboard.press('Escape').catch(() => {})
  return { ok: false, why: 'select2: no match for ' + word }
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

/**
 * The captcha picture, as a data: address for the notification (drawn from the
 * page itself: no screenshot, so the tab stays out of sight).
 */
async function captchaPicture(page) {
  return page.evaluate(() => {
    const seen = [...document.querySelectorAll('img')].filter(i => i.offsetParent !== null && i.naturalWidth > 30)
    const img = seen.find(i => /captcha/i.test(`${i.src} ${i.id} ${i.className} ${i.alt}`)) || null
    if (!img) return null
    const c = document.createElement('canvas')
    c.width = img.naturalWidth; c.height = img.naturalHeight
    c.getContext('2d').drawImage(img, 0, 0)
    return c.toDataURL('image/png')
  }).catch(() => null)
}

/**
 * Type the captcha into its box: a text box AFTER the password and after the
 * word "Captcha" — never the Login Name box (it comes before the password; a
 * wide search used to land there). Enjaz's captcha is digits: only digits go in.
 */
async function typeCaptcha(page, text) {
  const digits = String(text || '').replace(/[^0-9٠-٩]/g, '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  if (!digits) throw new Error('The captcha is numbers only')
  const ok = await page.evaluate((text) => {
    const seen = (e) => e && e.offsetParent !== null
    const pw = [...document.querySelectorAll('input[type="password"]')].find(seen)
    const after = (x, y) => !!(x && y && (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING))
    const texts = [...document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])')].filter(seen)
    const lab = [...document.querySelectorAll('label, span, div, td, th, p')].filter(seen).find(e => /^\s*\*?\s*(captcha|رمز التحقق|الرمز)\s*\*?\s*:?\s*$/i.test(e.innerText || ''))
    // After the password, and after the "Captcha" label when there is one; the nearest such box.
    const input = texts.find(i => (!pw || after(pw, i)) && (!lab || after(lab, i)))
      || texts.find(i => /captcha/i.test(`${i.id} ${i.name} ${i.placeholder}`))
    if (!input || (pw && !after(pw, input))) return false
    document.querySelectorAll('[data-adal-captcha]').forEach(e => e.removeAttribute('data-adal-captcha'))
    input.setAttribute('data-adal-captcha', '1')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
    return true
  }, digits)
  if (!ok) throw new Error('The captcha box was not found')
  // Typed key by key, like a person: the page's own checks see the numbers.
  const box = await page.$('[data-adal-captcha]')
  await box.focus()
  await box.type(digits, { delay: 40 })
  await page.evaluate(() => {
    const i = document.querySelector('[data-adal-captcha]')
    for (const t of ['input', 'change', 'keyup']) i?.dispatchEvent(new Event(t, { bubbles: true }))
  }).catch(() => {})
}

/**
 * Press the sign-in form's own Login button (the one in the same form as the
 * password, never a "Login" link elsewhere on the page); Enter in the captcha
 * box when there is no such button.
 */
async function pressLogin(page) {
  const h = await page.evaluateHandle(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const pw = [...document.querySelectorAll('input[type="password"]')].find(seen)
    if (!pw) return null
    const scope = pw.form || document
    const all = [...scope.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')].filter(seen)
    const after = all.filter(e => pw.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)
    const word = (e) => /^\s*(log ?in|sign ?in|دخول|تسجيل الدخول)\s*$/i.test((e.innerText || e.value || '').trim())
    return after.find(word) || all.find(word) || after.find(e => e.type === 'submit') || null
  })
  const el = h.asElement()
  if (el) {
    await el.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {})
    await el.click().catch(async () => { await el.evaluate(e => e.click()) })
    return true
  }
  const box = await page.$('[data-adal-captcha]')
  if (box) { await box.press('Enter').catch(() => {}); return true }
  return false
}

/**
 * Signed in: the platform left the login page, or it greets the user
 * ("Welcome …") and shows no password box.
 */
async function signedIn(page) {
  const st = await page.evaluate(() => ({
    pw: [...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null),
    welcome: /\bWelcome\s+\S+/i.test(document.body?.innerText || ''),
  })).catch(() => null)
  if (!st) return false
  if (st.pw) return false
  return !onLogin(page) || st.welcome
}

async function signIn(page, ctx) {
  const release = await signInTurn('mofa')
  try {
    log(ctx, `opening ${LOGIN_URL}`)
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
      .catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    await sleep(2500)
    await toEnglish(page, ctx)
    if (await signedIn(page)) {
      log(ctx, '✓ already signed in to the visa platform (shared sign-in)')
      return
    }
    if (!ctx.visa_username || !ctx.visa_password) {
      throw new Error('No visa platform account — add one under AI Actions → Visa platform login account')
    }
    await page.waitForSelector('input[type="password"]', { timeout: 60000 })
    await fillLogin(page, ctx)
    log(ctx, `🔐 Login Name and Password filled (${ctx.visa_name || ctx.visa_username}) — waiting for the captcha`)
    await ctx.notify(
      `🛂 ${ctx.profileName}: visa platform — type the captcha`,
      'Type the numbers in the picture here; Adal Keep signs in and continues by itself.',
      'warn', { login: page }
    )
    // The picture goes to the notification; what is typed there signs in here.
    // Only the LOGIN page's captcha is ever sent — never a picture of a page after it.
    let sentAt = 0, lastPic = null
    const onLoginForm = async () => onLogin(page) && !(await signedIn(page)) &&
      await page.evaluate(() => [...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null)).catch(() => false)
    const ask = async (title) => {
      if (!(await onLoginForm())) return
      const pic = await captchaPicture(page)
      if (!pic || pic === lastPic) return
      lastPic = pic
      ctx.askCaptcha?.(pic, async (text) => {
        // The answer goes into the very form its picture came from.
        if (!(await onLoginForm())) { log(ctx, 'the answer came after the sign-in page had gone — not typed', 'warn'); return }
        await fillLogin(page, ctx).catch(() => {})
        await typeCaptcha(page, text)
        const typed = await page.evaluate((t) => [...document.querySelectorAll('input')].some(i => i.value === t), text).catch(() => false)
        log(ctx, typed ? `captcha typed (${text.length} characters) — pressing Login` : 'the captcha did not stay in its box', typed ? 'info' : 'warn')
        sentAt = Date.now()
        if (!(await pressLogin(page))) log(ctx, 'the Login button was not found — press Login', 'warn')
        // Still on the same form a few seconds later: Enter in the captcha box.
        await sleep(5000)
        const digits = String(text).replace(/[^0-9]/g, '')
        if (await onLoginForm() && await page.evaluate((t) => document.querySelector('[data-adal-captcha]')?.value === t, digits).catch(() => false)) {
          log(ctx, 'Login did not go — pressing Enter in the captcha box', 'warn')
          await page.$('[data-adal-captcha]').then(b => b?.press('Enter')).catch(() => {})
        }
      }, { title })
    }
    await ask()
    const t0 = Date.now()
    while (Date.now() - t0 < LOGIN_WAIT_MS) {
      if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
      if (await signedIn(page)) break
      // A wrong captcha reloads the form empty: fill it again, and ask again —
      // once the page is back on the login form with a NEW picture.
      await fillLogin(page, ctx).catch(() => {})
      if (sentAt && Date.now() - sentAt > 12000 && await onLoginForm()) {
        const pic = await captchaPicture(page)
        if (pic && pic !== lastPic) { sentAt = 0; log(ctx, 'the captcha was not accepted — asking again', 'warn'); await ask('Not accepted: type the new numbers') }
      }
      await sleep(2000)
    }
    if (!(await signedIn(page))) throw new Error('Nobody signed in to the visa platform within 30 minutes')
    log(ctx, '✓ signed in to the visa platform')
    await toEnglish(page, ctx)
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

/**
 * DocumentNumber = her visa number (10 digits, from Musaned). Typing it makes
 * the platform look the visa up and list its occupations; the one matching
 * her job is chosen. No list (the visa is not found): Classify Occupations →
 * "Building and housekeeping…", then "House work".
 */
async function documentAndOccupation(page, ctx, v, left) {
  if (!(await page.$('#DocumentNumber'))) return
  const want = new RegExp(v.occupation || 'house ?work|house ?maid|domestic|housekeeper|عاملة منزلية|خادمة', 'i')
  const options = () => page.$$eval('#JOB_OR_RELATION_Id option', os => os.map(o => ({ v: o.value, t: o.text.trim() })).filter(o => o.v && o.v !== '0')).catch(() => [])
  const choose = async () => {
    const os = await options()
    // "House work" first; then the other house-help names.
    const o = os.find(x => /house ?work/i.test(x.t)) || os.find(x => want.test(x.t)) || (os.length === 1 ? os[0] : null)
    if (!o) return null
    await page.evaluate((val) => {
      const s = document.getElementById('JOB_OR_RELATION_Id')
      if (window.jQuery) window.jQuery(s).val(val).trigger('change'); else { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })) }
    }, o.v)
    return o.t
  }

  const cur = await page.$eval('#DocumentNumber', e => e.value).catch(() => '')
  const doc = String(v.visa_number || '').replace(/\D/g, '')
  if (!cur) {
    if (!doc) left.push('DocumentNumber (her visa number — not on the profile yet)')
    else {
      await page.click('#DocumentNumber', { clickCount: 3 }).catch(() => {})
      await page.type('#DocumentNumber', doc, { delay: 40 })
      await page.evaluate(() => { const e = document.getElementById('DocumentNumber'); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur() })
      log(ctx, `✓ DocumentNumber: ${doc} (her visa number)`)
    }
  }
  // Classify Occupations: always "Building and housekeeping" (then the visa's own occupations).
  const pickClass = async () => {
    const cls = await page.$$eval('#ddlClassifyOccupations option', os => (os.find(o => /building and house ?keep/i.test(o.text)) || os.find(o => /house ?keep|domestic/i.test(o.text)) || {}).value || '').catch(() => '')
    if (!cls) return false
    await page.evaluate((val) => { const s = document.getElementById('ddlClassifyOccupations'); if (window.jQuery) window.jQuery(s).val(val).trigger('change'); else { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })) } }, cls)
    log(ctx, '✓ Classify Occupations: Building and housekeeping')
    return true
  }
  if (await page.$('#ddlClassifyOccupations')) await pickClass()
  // The visa's own occupations come back after a moment.
  for (let i = 0; i < 24 && !(await options()).length; i++) await sleep(500)
  let got = await choose()
  if (!got) {
    const cls = await page.$$eval('#ddlClassifyOccupations option', os => (os.find(o => /building and housekeep/i.test(o.text)) || os.find(o => /housekeep|domestic/i.test(o.text)) || {}).value || '').catch(() => '')
    if (cls) {
      await page.evaluate((val) => { const s = document.getElementById('ddlClassifyOccupations'); if (window.jQuery) window.jQuery(s).val(val).trigger('change'); else { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })) } }, cls)
      log(ctx, '✓ Classify Occupations: Building and housekeeping')
      for (let i = 0; i < 24 && !(await options()).length; i++) await sleep(500)
      got = await choose()
    }
  }
  if (got) log(ctx, `✓ Occupation: ${got}`)
  else left.push(`Occupation${(await options()).length ? ` (choices: ${(await options()).slice(0, 5).map(o => o.t).join(', ')})` : ''}`)
}

/** Fills the long form. Returns what is still for a person to fill. */
async function fillForm(page, ctx, v) {
  const left = []
  const select = async (label, key, src, name = label, typeWord = '') => {
    const kind = await markField(page, label, key, 'select')
    if (!kind) return
    let r = await setSelect(page, key, src, ctx)
    // An empty list: one that fills as you type (Issuing Country) — type her country.
    if (!r.ok && !r.options?.length && typeWord) {
      const t = await typeInSelect(page, key, typeWord, src)
      if (t.ok) r = t
      else log(ctx, `${name}: the list stayed empty (${t.why})`, 'warn')
    }
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
  await documentAndOccupation(page, ctx, v, left)

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
      // The personal photo's own box (#PersonalImage, "Select Image") — not
      // the hidden passport-image boxes of other visa kinds.
      const files = [...document.querySelectorAll('input[type="file"]')]
      return document.getElementById('PersonalImage')
        || files.find(f => f.offsetParent !== null && /image|jpe?g|png/i.test(f.accept || ''))
        || files.find(f => f.offsetParent !== null) || null
    })).asElement()
    if (input) {
      const before = await page.$eval('#image', i => i.src).catch(() => '')
      // The box sends the picture to the platform by itself (blueimp upload)
      // and shows it in the frame above "Select Image".
      await input.uploadFile(jpg)
      const shown = await page.waitForFunction((b) => { const i = document.getElementById('image'); return i && i.src !== b && i.complete && i.naturalWidth > 0 }, { timeout: 30000, polling: 500 }, before).then(() => true).catch(() => false)
      if (shown || !before) log(ctx, '✓ Personal photo uploaded')
      else left.push('Personal photo (Select Image — the platform did not show it)')
    } else left.push('Personal photo (Select Image)')
  } else left.push('Personal photo (no Photo file on the profile)')

  await setRadio(page, 'do you have previous nationality', v.previous_nationality)
    .then(ok => ok ? log(ctx, '✓ Previous nationality: No') : left.push('Previous nationality (Yes/No)'))

  log(ctx, '✍️ Passport')
  await text('passport (?:no\\.?|number)', 'pnum', v.passport, 'Passport Number')
  await select('passport type', 'ptype', v.passport_type, 'Passport Type')
  await select('issuing country', 'pcountry', 'ethiopia|إثيوبيا|اثيوبيا|أثيوبيا', 'Issuing Country', 'Ethiopia')
  await date('date of issue', 'pissue', v.issue_date, 'Date of Issue')
  await date('date of expiry', 'pexpiry', v.expiry_date, 'Date of Expiry')
  await text('place of birth', 'pob', v.birth_place, 'Place of Birth')
  await date('date of birth', 'dob', v.dob, 'Date of Birth')
  await text('id number', 'idnum', v.id_number, 'ID Number')

  await select('religion', 'religion', v.religion, 'Religion')
  await select('marital status', 'marital', v.marital, 'Marital Status')
  await select('gender', 'gender', v.gender, 'Gender')
  if (!(await page.$eval('#JOB_OR_RELATION_Id', e => e.value && e.value !== '0').catch(() => false))) {
    await select('occupation', 'occupation', v.occupation, 'Occupation')
  }
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
  // Port of Entry: left empty on purpose (asked on 2026-11-10).
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
    const m = t.match(/application\s*(?:no\.?|number)[^A-Z0-9]{0,40}([A-Z]?\d{6,})/i) || t.match(/رقم الطلب[^A-Z0-9]{0,40}([A-Z]?\d{6,})/i)
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
  try {
    await openForm(page, ctx)
  } catch (e) {
    if (e?.cancelled || !onLogin(page)) throw e
    // Signed out on the way (an old session): sign in again, then go on.
    log(ctx, 'the visa platform asked to sign in again', 'warn')
    await signIn(page, ctx)
    await openForm(page, ctx)
  }
  const left = await fillForm(page, ctx, v)

  // Leave the captcha box ready for the person.
  await page.evaluate(() => {
    const lab = [...document.querySelectorAll('label, span, div, td')].find(e => /^\s*\*?\s*captcha\s*\*?\s*$/i.test(e.innerText || ''))
    let box = lab?.parentElement, input = null
    for (let i = 0; i < 3 && box && !input; i++, box = box.parentElement) input = box.querySelector('input[type="text"], input:not([type])')
    if (input) { input.scrollIntoView({ block: 'center' }); input.focus() }
  }).catch(() => {})

  await ctx.noteProfile?.(`Visa: form filled — waiting for a person to type the captcha and press Save${left.length ? ` (also to fill: ${left.join('; ')})` : ''}`, { visa_stage: VISA_STAGES.waiting })
  await ctx.notify(
    `🛂 ${ctx.profileName}: visa form filled — type the captcha, then Open and press Save`,
    (left.length ? `Still to fill: ${left.join('; ')}. ` : 'Every field is filled. ') +
    'Type the captcha here, then press Open, look the form over and press Save.',
    'warn', { login: page }
  )
  // Typed into the form only: Save stays a person's.
  // The form's own captcha (after the sign-in) is NOT sent out: the person
  // types it on the form when they look it over and press Save.
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


// ---------------------------------------------------------------------------
// Pay visa fees (workflow id: mofa_pay)
// ---------------------------------------------------------------------------

export const MOFA_PAY = 'mofa_pay'
const PAY_URL = 'https://visa.mofa.gov.sa/Payment/GetApp'

/** Types into the box under a label ("Application Number", "Passport Number"). */
async function typeUnder(page, labelSrc, value) {
  const kind = await markField(page, labelSrc, 'pay-' + labelSrc.replace(/\W/g, ''), 'input')
  if (!kind) return false
  const el = await page.$(`[data-adal-v="pay-${labelSrc.replace(/\W/g, '')}"]`)
  if (!el) return false
  await el.click({ clickCount: 3 }).catch(() => {})
  await el.evaluate(e => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })) })
  await el.type(String(value), { delay: 30 })
  await el.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true })))
  return true
}

/** After Search: what the page says about her application (paid or not). */
async function readPayResult(page) {
  return page.evaluate(() => {
    const t = (document.querySelector('main, #content, .container, body')?.innerText || '').replace(/\s+/g, ' ')
    const paid = /already\s+paid|has\s+been\s+paid|payment\s+(?:is\s+)?(?:done|completed|successful)|تم\s+السداد|مدفوع/i.test(t) && !/not\s+paid|unpaid|غير\s+مدفوع/i.test(t)
    const notFound = /no\s+(?:data|record|result)s?\s+found|not\s+found|لا\s+توجد/i.test(t)
    const amount = (t.match(/(?:amount|total|fees?)\D{0,20}(\d[\d,.]*)\s*(?:SAR|ر\.?س|riyal)/i) || [])[1] || ''
    return { paid, notFound, amount, text: t.slice(0, 400) }
  }).catch(() => ({ paid: false, notFound: false, amount: '', text: '' }))
}

/**
 * "Pay visa fees": the visa platform (sign-in: a person types the captcha) →
 * Pay Visa Fees → her application number and passport number → Search →
 * the tab comes to the front and rings: a person checks and pays. Already
 * paid → her profile says so (visa_stage "Visa paid") and the run is done.
 */
export async function runMofaPay(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const p = ctx.profile || {}
  const app = String(p.visa_application_number || '').trim()
  const pp = String(p.passport_number || '').trim().toUpperCase()
  const missing = [!app && 'Application number (from the visa application)', !pp && 'Passport number'].filter(Boolean)
  if (missing.length) return { ok: false, step: 'preflight', error: `Profile is missing for the visa payment: ${missing.join(', ')}`, seconds: 0 }

  log(ctx, `💳 Visa fees for ${ctx.profileName} — application ${app}`)
  await signIn(page, ctx)
  // Pay Visa Fees (the menu), else its page straight away.
  if (!(await clickText(page, /^\s*Pay\s+Visa\s+Fees\s*$/))) await page.goto(PAY_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
  if (!(await until(async () => !!(await markField(page, 'Application\\s*Number', 'pay-probe', 'input')), 30000, ctx))) {
    if (onLogin(page)) { await signIn(page, ctx); await page.goto(PAY_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}) }
  }
  await sleep(1000)
  const a = await typeUnder(page, 'Application\\s*Number', app)
  const b = await typeUnder(page, 'Passport\\s*Number', pp)
  if (!a || !b) log(ctx, `could not find the ${!a ? 'Application Number' : 'Passport Number'} box — a person fills it`, 'warn')
  else log(ctx, `typed application ${app} and passport ${pp}`)
  if (a && b) {
    await clickText(page, /^\s*Search\s*$/)
    log(ctx, 'pressed Search')
    await sleep(4000)
  }
  const r = await readPayResult(page)
  if (r.paid) {
    await ctx.noteProfile?.(`Visa: fees already paid (application ${app})`, { visa_stage: 'Visa paid' })
    log(ctx, '✅ the visa fees are already paid')
    return { ok: true, done: true, seconds: secs() }
  }
  if (r.notFound) log(ctx, `the platform found nothing for application ${app} / passport ${pp}`, 'warn')
  await ctx.noteProfile?.(`Visa: fee page open — waiting for a person to pay (application ${app}${r.amount ? `, ${r.amount} SAR` : ''})`)
  await page.bringToFront().catch(() => {})
  await ctx.notify(
    `💳 ${ctx.profileName}: pay the visa fees`,
    `The visa platform's Pay Visa Fees page is in front with application ${app} and passport ${pp} searched${r.notFound ? ' — it found nothing; check the numbers' : ''}. Check it and pay, then press "✔️ Visa paid".`,
    'warn'
  )
  return { ok: true, pauseReason: 'awaiting-visa-pay', seconds: secs() }
}

// ---------------------------------------------------------------------------
// Find her application (workflow id: mofa_find_app)
// ---------------------------------------------------------------------------

export const MOFA_FIND = 'mofa_find_app'

/**
 * SmartForm's list of visa applications, searched by her passport number:
 * her row's Application Number (the first column) and what its Actions say —
 * "Print | Edit" = the visa fees are paid, only "Edit" = not paid yet, and the
 * status "Visa Printed" = the visa is issued.
 */
async function readAppRow(page, pp) {
  return page.evaluate((pp) => {
    const rows = [...document.querySelectorAll('tr')].filter(r => r.querySelectorAll('td').length >= 3)
    const tr = rows.find(r => (r.innerText || '').toUpperCase().replace(/\s+/g, '').includes(pp))
    if (!tr) return null
    const cells = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim())
    const head = [...(tr.closest('table')?.querySelectorAll('th') || [])].map(th => (th.innerText || '').trim())
    const at = (re) => { const i = head.findIndex(h => re.test(h)); return i >= 0 ? cells[i] || '' : '' }
    const app = (at(/application\s*number/i) || cells[0] || '').match(/[A-Z]?\d{6,}/i)?.[0] || ''
    const status = at(/status/i)
    const actions = (at(/actions?/i) || cells[cells.length - 1] || '')
    return { app, status, print: /print/i.test(actions), edit: /edit/i.test(actions), printed: /visa\s*printed/i.test(tr.innerText || '') }
  }, pp).catch(() => null)
}

export async function runMofaFindApp(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const pp = String(ctx.profile?.passport_number || '').trim().toUpperCase()
  if (!pp) return { ok: false, step: 'preflight', error: 'Profile is missing the passport number', seconds: 0 }
  log(ctx, `🔎 Finding the visa application of ${ctx.profileName} (passport ${pp})`)
  await signIn(page, ctx)
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
  if (onLogin(page)) { await signIn(page, ctx); await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}) }
  await until(async () => !!(await markField(page, 'Passport\\s*Number', 'find-probe', 'input')), 30000, ctx)
  await sleep(800)
  if (!(await typeUnder(page, 'Passport\\s*Number', pp))) throw new Error('The Passport Number box was not found on the list of visa applications')
  await clickText(page, /^\s*Search\s*$/)
  log(ctx, `searched passport ${pp}`)
  let r = null
  await until(async () => !!(r = await readAppRow(page, pp)), 20000, ctx)
  if (!r || !r.app) {
    await ctx.noteProfile?.(`Visa: no application found on the visa platform for passport ${pp}`)
    return { ok: false, step: 'find', error: `No visa application found for passport ${pp}`, seconds: secs() }
  }
  const stage = r.printed ? 'Visa printed' : r.print ? 'Visa paid' : 'Visa applied'
  const said = r.printed ? 'the visa is printed' : r.print ? 'the visa fees are paid' : 'the visa fees are NOT paid yet'
  await ctx.noteProfile?.(`Visa: application number ${r.app} — ${said}`, { visa_application_number: r.app, visa_stage: stage })
  log(ctx, `✅ application ${r.app} — ${said}`)
  if (!r.print && !r.printed) {
    await ctx.notify(`💳 ${ctx.profileName}: visa fees not paid`, `Application ${r.app} on the visa platform has no Print yet: the fees are not paid. "Pay visa fees" opens the payment.`, 'info')
  }
  return { ok: true, done: true, seconds: secs() }
}
export { captchaPicture, typeCaptcha, pressLogin }   // tests
