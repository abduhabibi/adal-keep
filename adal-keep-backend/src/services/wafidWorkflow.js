/**
 * wafidWorkflow.js — Wafid (GCC medical examination).
 *
 * 1. Booking  (workflow "wafid_book", one run = one background tab)
 *    Opens wafid.com/en/book-appointment, chooses the appointment location
 *    (Ethiopia → city → destination), picks the Standard Appointment that
 *    then appears, fills every candidate detail from the profile, ticks
 *    "I confirm that the information …", plays a sound — and STOPS.
 *    "Save And Continue", the SMS code and the payment are always done by a
 *    person in that tab. The run waits as "awaiting-human-save".
 *
 * 2. Status   (checkMedicalStatus) — wafid.com/en/medical-status-search:
 *    passport + nationality → Check → FIT / UNFIT / not yet.
 *
 * Wafid checks the browser with Google's invisible reCAPTCHA. Nothing here
 * touches it: the run works in the agency's own Brave like a person. If
 * Wafid ever shows a challenge, the run stops and calls a person.
 */
const BOOK_URL = 'https://wafid.com/en/book-appointment/'
const STATUS_URL = 'https://wafid.com/en/medical-status-search/'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function log(ctx, msg, level = 'info') {
  if (ctx?.isCancelled?.()) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
  console.log(`[wafid] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}

// Destination → Wafid's "Country Traveling To" code.
const TRAVEL = { 'saudi arabia': 'SA', saudi: 'SA', ksa: 'SA', kuwait: 'KW', qatar: 'QA', oman: 'OM', bahrain: 'BH', uae: 'UAE', 'united arab emirates': 'UAE', yemen: 'YEM', jordan: null }

/** "AMBERIYA UMER ERPA" → { first: "AMBERIYA UMER", last: "ERPA" } (passport: given names / surname). */
export function splitName(p) {
  const full = String(p.full_name || [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ')).trim().replace(/\s+/g, ' ')
  const parts = full.split(' ')
  if (parts.length < 2) return { first: full, last: String(p.last_name || '').trim() }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

/** +251 and 9 digits (Wafid allows 14 characters). */
export function wafidPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^(251|0)/, '')
  return d ? `+251${d}` : ''
}

const isoDate = (v) => {
  if (!v) return ''
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return isNaN(d) ? '' : d.toISOString().slice(0, 10)
}

/** What the booking form gets, from the profile (and agency settings). */
export function bookingValues(profile, opts = {}) {
  const { first, last } = splitName(profile)
  const dest = String(profile.destination_country || '').trim().toLowerCase()
  const travel = dest ? TRAVEL[dest] : undefined
  const g = String(profile.gender || '').trim().toUpperCase()
  const m = String(profile.marital_status || '').trim().toUpperCase()
  return {
    country: 'ETH',
    city: opts.city || 'Addis Ababa',
    travel,
    first_name: first.toUpperCase(),
    last_name: last.toUpperCase(),
    dob: isoDate(profile.date_of_birth),
    nationality: 'Ethiopian',
    gender: g.startsWith('M') ? 'male' : g.startsWith('F') ? 'female' : '',
    marital_status: m.startsWith('MARRIED') ? 'married' : m ? 'unmarried' : '',
    passport: String(profile.passport_number || '').trim().toUpperCase().replace(/\s+/g, ''),
    passport_issue_date: isoDate(profile.passport_issue_date),
    passport_issue_place: (opts.issuePlace || 'ADDIS ABABA').toUpperCase(),
    passport_expiry_on: isoDate(profile.passport_expiry_date),
    visa_type: 'wv',
    email: opts.email || '',
    phone: wafidPhone(profile.phone_number),
    national_id: String(profile.national_id || '').trim(),
    position: opts.position || 'House Maid',
  }
}

/** Fields the booking cannot do without — said before Wafid is even opened. */
export function missingForBooking(v) {
  const need = { travel: 'destination country (Saudi Arabia, Kuwait, …)', first_name: 'name', last_name: 'surname', dob: 'date of birth', gender: 'gender', marital_status: 'marital status', passport: 'passport number', passport_issue_date: 'passport issue date', passport_expiry_on: 'passport expiry date', phone: 'phone number', email: 'agency email (Settings)' }
  return Object.entries(need).filter(([k]) => !v[k]).map(([, label]) => label)
}

async function challengeShown(page) {
  return page.evaluate(() => [...document.querySelectorAll('iframe')].some(f => /recaptcha\/api2\/bframe|recaptcha\/enterprise\/bframe/.test(f.src) && f.offsetParent !== null)).catch(() => false)
}

/**
 * Fill the booking form in this tab. Returns the worker's result:
 * { ok:true, pauseReason } when it waits for a person, { ok:false, error } else.
 */
export async function runWafidBooking(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const v = bookingValues(ctx.profile || {}, ctx.wafid || {})
  const missing = missingForBooking(v)
  if (missing.length) {
    return { ok: false, step: 'preflight', error: `Profile is missing for Wafid: ${missing.join(', ')}`, seconds: 0 }
  }

  log(ctx, `🩺 Wafid booking for ${ctx.profileName} — opening the booking page`)
  await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('#id_country', { timeout: 30000 })
  await page.waitForFunction(() => !!window.jQuery && !!window.jQuery.fn.calendar, { timeout: 30000 }).catch(() => {})
  await sleep(800)

  // 1. Appointment location → the appointment type appears.
  log(ctx, `📍 Location: Ethiopia · ${v.city} · travelling to ${v.travel}`)
  const loc = await page.evaluate((v) => {
    const $ = window.jQuery
    const pick = (sel, val) => { $(sel).val(val).trigger('change'); return $(sel).val() === val }
    if (!pick('#id_country', v.country)) return 'country'
    const city = [...document.querySelector('#id_city').options].find(o => o.text.trim().toLowerCase() === v.city.toLowerCase())
    if (!city || !pick('#id_city', city.value)) return `city "${v.city}"`
    if (!pick('#id_traveled_country', v.travel)) return 'country traveling to'
    return ''
  }, v)
  if (loc) return { ok: false, step: 'location', error: `Wafid: could not choose the ${loc}`, seconds: secs() }

  // The Standard Appointment card shows up once the location is chosen.
  try {
    await page.waitForFunction(() => {
      const r = document.querySelector('#id_appointment_type_0')
      const box = r?.closest('.ui.radio.checkbox')
      return box && box.offsetParent !== null
    }, { timeout: 30000, polling: 300 })
  } catch {
    return { ok: false, step: 'appointment-type', error: 'Wafid did not show the appointment type after the location was chosen', seconds: secs() }
  }
  const box = await page.$('#id_appointment_type_0')
  const card = box && await box.evaluateHandle(el => el.closest('.ui.radio.checkbox') || el.parentElement)
  if (card) await card.asElement().click().catch(() => {})
  await page.evaluate(() => {
    const $ = window.jQuery
    if (!$('#id_appointment_type_0').prop('checked')) $('#id_appointment_type_0').closest('.ui.radio.checkbox').checkbox?.('check')
  })
  const typeOk = await page.$eval('#id_appointment_type_0', r => r.checked).catch(() => false)
  if (!typeOk) return { ok: false, step: 'appointment-type', error: 'Wafid: could not choose the Standard Appointment', seconds: secs() }
  log(ctx, '✅ Standard Appointment chosen (medical center is assigned by Wafid)')
  await sleep(600)

  // 2. Candidate information.
  log(ctx, '✍️ Filling the candidate details')
  const problems = await page.evaluate((v) => {
    const $ = window.jQuery
    const bad = []
    const text = (id, val) => {
      const el = document.getElementById(id)
      if (!el) { bad.push(id); return }
      el.focus(); $(el).val(val).trigger('input').trigger('change'); el.blur()
      if (String(el.value).trim() !== String(val).trim()) bad.push(id)
    }
    const select = (id, val) => { $('#' + id).val(val).trigger('change'); if ($('#' + id).val() !== val) bad.push(id) }
    const selectText = (id, label) => {
      const o = [...document.getElementById(id).options].find(o => o.text.trim().toLowerCase() === label.toLowerCase())
      if (!o) { bad.push(id); return }
      select(id, o.value)
    }
    const date = (id, iso) => {
      if (!iso) return
      const [y, m, d] = iso.split('-').map(Number)
      const cal = $('#' + id).closest('.ui.calendar')
      try { cal.calendar('set date', new Date(y, m - 1, d, 12), true, true) } catch {}
      if (!$('#' + id).val()) $('#' + id).val(iso).trigger('change')
      if (!$('#' + id).val()) bad.push(id)
    }
    text('id_first_name', v.first_name)
    text('id_last_name', v.last_name)
    date('id_dob', v.dob)
    selectText('id_nationality', v.nationality)
    select('id_gender', v.gender)
    select('id_marital_status', v.marital_status)
    text('id_passport', v.passport)
    text('id_confirm_passport', v.passport)
    date('id_passport_issue_date', v.passport_issue_date)
    text('id_passport_issue_place', v.passport_issue_place)
    date('id_passport_expiry_on', v.passport_expiry_on)
    select('id_visa_type', v.visa_type)
    text('id_email', v.email)
    text('id_phone', v.phone)
    if (v.national_id) text('id_national_id', v.national_id)
    if (v.position) {
      const o = [...document.getElementById('id_applied_position').options].find(o => o.text.trim().toLowerCase() === v.position.toLowerCase())
      if (o) select('id_applied_position', o.value)
    }
    // "I confirm that the information given in this form is true, complete, and accurate"
    const c = $('#id_confirm')
    if (!c.prop('checked')) { c.closest('.ui.checkbox').checkbox?.('check'); if (!c.prop('checked')) c.prop('checked', true).trigger('change') }
    if (!c.prop('checked')) bad.push('id_confirm')
    // Close any date popup left open.
    $('.ui.calendar .ui.popup').removeClass('visible').addClass('hidden')
    return bad
  }, v)

  const values = await page.evaluate(() => ({
    dob: document.getElementById('id_dob')?.value, issue: document.getElementById('id_passport_issue_date')?.value,
    expiry: document.getElementById('id_passport_expiry_on')?.value,
  })).catch(() => ({}))
  log(ctx, `📅 Dates in the form: birth ${values.dob || '—'} · issued ${values.issue || '—'} · expires ${values.expiry || '—'}`)

  if (problems.length) {
    log(ctx, `⚠ Please check these Wafid fields: ${problems.map(p => p.replace(/^id_/, '').replace(/_/g, ' ')).join(', ')}`, 'warn')
  }
  if (await challengeShown(page)) log(ctx, '⚠ Wafid shows a "I am not a robot" check — a person must answer it', 'warn')

  // Bring the Save button into view for the person — never pressed here.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /save and continue/i.test(x.innerText))
    b?.scrollIntoView({ block: 'center' })
  }).catch(() => {})

  await ctx.notify?.(
    `Wafid form ready — ${ctx.profileName}`,
    `Everything is filled and "I confirm…" is ticked${problems.length ? ` (check: ${problems.join(', ')})` : ''}. ` +
    'In the Wafid tab: check it, press "Save And Continue", enter the SMS code and pay. Then press Complete on the run.',
    problems.length ? 'warn' : 'info'
  )
  log(ctx, '🔔 Filled. Waiting for a person to press "Save And Continue" (never pressed by Adal Keep)')
  return { ok: true, pauseReason: 'awaiting-human-save', seconds: secs() }
}

/**
 * Check one passport on wafid.com/en/medical-status-search in `page`.
 * Returns { state: 'fit'|'unfit'|'pending'|'none'|'challenge'|'unknown', text }.
 */
export async function checkMedicalStatus(page, passport, nationality = 'Ethiopian') {
  await page.goto(STATUS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('#id_passport', { timeout: 30000 })
  // The page asks Google for its invisible token on load; give it a moment.
  await page.waitForFunction(() => !!document.querySelector('#id_captcha')?.value, { timeout: 15000, polling: 300 }).catch(() => {})

  const filled = await page.evaluate((passport, nat) => {
    const $ = window.jQuery
    const pr = document.getElementById('id_search_variant_0')
    if (pr && !pr.checked) pr.click()
    const p = document.getElementById('id_passport')
    p.focus(); p.value = passport; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new Event('change', { bubbles: true }))
    const o = [...document.getElementById('id_nationality').options].find(o => o.text.trim().toLowerCase() === nat.toLowerCase())
    if (!o) return false
    if ($) $('#id_nationality').val(o.value).trigger('change'); else document.getElementById('id_nationality').value = o.value
    return true
  }, passport, nationality)
  if (!filled) return { state: 'unknown', text: `nationality "${nationality}" not in Wafid's list` }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null),
    page.click('#med-status-form-submit'),
  ])
  await sleep(1500)
  if (await challengeShown(page)) return { state: 'challenge', text: 'Wafid asks "I am not a robot"' }

  const res = await page.evaluate(() => {
    const body = document.body.innerText || ''
    // The result card starts with the status (✓ FIT); errors are form messages.
    const card = [...document.querySelectorAll('.ui.segment, .card, .result, .ui.message, .errorlist, .ui.error')]
      .map(e => e.innerText.trim()).filter(Boolean)
    return { body: body.slice(0, 4000), card: card.slice(0, 6) }
  })
  const top = res.body.replace(/\s+/g, ' ')
  const scan = (res.card.join(' ') + ' ' + top).toUpperCase()
  if (/\bUNFIT\b|NOT FIT/.test(scan)) return { state: 'unfit', text: 'UNFIT' }
  if (/(^|[^A-Z])FIT\b/.test(scan) && /CANDIDATE INFORMATION|PASSPORT NO/i.test(top)) return { state: 'fit', text: 'FIT' }
  if (/NO ACTIVE APPOINTMENT|NO RECORD|NOT FOUND|NO DATA|NO RESULT|DOES NOT EXIST|INVALID/.test(scan)) return { state: 'none', text: /NO ACTIVE APPOINTMENT/.test(scan) ? 'No active appointment found' : 'no record' }
  if (/CANDIDATE INFORMATION/i.test(top)) {
    const m = top.match(/Your Medical Examinations Results.*?Check\s+(.{0,60})/i)
    return { state: 'pending', text: (m?.[1] || 'result not final yet').trim().slice(0, 120) }
  }
  return { state: 'unknown', text: (res.card[0] || top.slice(0, 160)) }
}
