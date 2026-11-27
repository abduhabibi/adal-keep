/**
 * tasheer.js — Tasheer (agents.tasheer.com), the visa centre's agent site.
 * Workflow id: tasheer_schedule. For one girl (her profile) or several (the
 * selected ones, one group appointment):
 *
 *   1. Sign-in page: the Tasheer account's name and password are filled; a
 *      person types the site's captcha and signs in (Adal Keep rings).
 *   2. GROUP SCHEDULING → VISA Type Work, VSC Center Addis Ababa, Number of
 *      Applicants = how many → rings: a person picks the day and the time,
 *      types the captcha and presses Submit.
 *   3. The upload page (Option 1): Tasheer's own template is read (Step 1)
 *      and the Excel made to match it, chosen, Upload Sheet pressed and the
 *      site's answer awaited (rows filled / Save enabled / its error, which
 *      is reported). Option 2 (the grid typed) only when Option 1 cannot be.
 *      The consent box ticked, Save pressed, its confirmation answered; a
 *      time-slot step, if one comes, is the person's.
 *   After the first sign-in Tasheer says "Concurrent Login": SUBMIT, the same
 *   name and password again, the new captcha, LOGIN.
 *   Every captcha (sign-in, Concurrent Login, the scheduling page) comes by
 *   notification with its picture (PC and phones): the code typed there goes
 *   in by itself — nobody opens the Tasheer tab for it (captchaByNotice). No
 *   answer in 10 minutes: the run pauses ('awaiting-tasheer-code').
 *
 * Only for girls whose visa is made: the E.No column is her visa
 * application number.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { signInTurn } from './tabManager.js'
import { visaNames, clickText } from './mofaVisa.js'
import { doneWith } from './attention.js'
import { waitSign, quietNet } from './pasteAll.js'

export const TASHEER = 'tasheer_schedule'
// Tasheer's own front page (its sign-in). Its inner pages (/auth/cnav,
// /auth/agentGroupScheduling) open only from inside the site (a POST): typed
// as an address they say "Method 'GET' is not supported".
const START = 'https://agents.tasheer.com/AgentTasheer/'
const LOGIN_WAIT_MS = 30 * 60 * 1000
const PICK_WAIT_MS = 60 * 60 * 1000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
import { settle, pollUntil } from './fastSteps.js'
const cancelled = (ctx) => typeof ctx?.isCancelled === 'function' && ctx.isCancelled()
const stop = (ctx) => { if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e } }
function log(ctx, msg, level = 'info') {
  stop(ctx)
  console.log(`[tasheer] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}
async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) { stop(ctx); if (await test().catch(() => false)) return true; await sleep(300) }   // 300 ms: the page's signal is seen at once (was 1 s)
  return false
}

// Tasheer's nationality list (the template's hidden sheet).
const COUNTRIES = ["Afghanistan","Albania","Algeria","American Samoa","Andorra","Angola","Anguilla","Antarctic","Antigua","Argentina","Armenia","Aruba","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bermuda","Bhutan","Bolivia","Bosnia","Botswana","Bouvet Island","Brazil","British Indian Ocean Territory","Brunei","Bulgaria","Burkina Faso","Burundi","Cambodia","Cameroon","Canada","Cape Verde","Cayman Island","Central African Republic","Chad","Chile","China","Christmas Island","Cocos Island","Colombia","Comoros","Congo","Cook Island","Costa Rica","Cote Divoire","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominica","Dominican Republic","East Timor","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Ethiopia","Falkland Islands","Faroe Islands","Fiji","Finland","France","France Metropolitan","French Guiana","French Polynesia","French Southern and Antarctic","Gabon","Gambia","Georgia","Germany","Ghana","Gibraltar","Greece","Greenland","Grenada","Guadeloupe","Guam","Guatemala","Guinea","Guinea Bissau","Guyana","Haiti","Heard Island and McDonald Island","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Korea, North","Korea, South","Kosovo","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Macau","Macedonia, The Former Yugoslav Republic of","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Island","Martinique","Mauritania","Mauritius","Mayotte","Mexico","Micronesia, Federated Stat","Monaco","Mongolia","Montenegro","Montserrat","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","Netherlands Antilles","New Caledonia","New Zealand","Nicaragua","Niger","Nigeria","Niue","Non Bahraini","Non Emirati","Non Kuwaiti","Non Omani","Non Qatari","Norfolk Island","Northern Mariana Islands","Norway","Pakistan","Palau","Palestinian Territory Occupied","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Pitcairn Islands","Poland","Portugal","Puerto Rico","Republic of Moldova","Reunion","Romania","Russian Federation","Rwanda","Saint Kitts and Nevis","Saint Lucia","Saint Pierre and Miquelon","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome And Principe","Senegal","Serbia","Serbia and Montenegro","Seychelles","Sierra Leone","Singapore","Slovak Republic","Slovenia","Solomon Islands","Somalia","South Africa","South Georgia and The South","Spain","Sri Lanka","St Helena","Sudan","Suriname","Svalbard","Swaziland","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Thailand","Togo","Tokelau","Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Turks and Caicos Islands","Tuvalu","Uganda","Ukraine","United Kingdom","United States","United States Minor Outlying Islands","UR Tanzania","Uruguay","Uzbekistan","Vanuatu","Vatican City State","Venezuela","Vietnam","Virgin Islands","Virgin Islands US","Wallis and Futuna","Yemen","Yugoslavia","Zaire","Zambia","Zimbabwe"]

const HEAD = ['E.No', 'First Name*', 'Second Name', 'Last Name*', 'Passport Number*', 'Date of Birth*', 'Nationality*', 'Date of Issue*', 'Gender*', 'Place of Issue*', 'Expiry Date*', 'Applicant Mobile No.*', 'Email ID*']
const WIDTHS0 = [11.6, 12.1, 13, 11.2, 17.4, 13.3, 11.8, 13.4, 9.1, 15.1, 12, 20.8, 22.8]

const isoDate = (v) => {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return s && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''
}
const serial = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000) }

/** Her row on Tasheer's sheet. */
export function tasheerRow(p, settings = {}) {
  const n = visaNames(p || {})
  const g = String(p?.gender || '').trim().toUpperCase()
  const phone = (() => { const d = String(p?.phone_number || '').replace(/\D/g, ''); return !d ? '' : d.startsWith('251') ? d : d.startsWith('0') ? `251${d.slice(1)}` : d.length === 9 ? `251${d}` : d })()
  return {
    eno: String(p?.visa_application_number || '').trim().toUpperCase(),
    first: n.first, second: n.father, last: [n.grandfather, n.family].filter(Boolean).join(' '),
    passport: String(p?.passport_number || '').trim().toUpperCase().replace(/\s+/g, ''),
    dob: isoDate(p?.date_of_birth),
    nationality: 'Ethiopia',
    issued: isoDate(p?.passport_issue_date),
    gender: g.startsWith('F') ? 'FEMALE' : g.startsWith('M') ? 'MALE' : '',
    place: String(settings.issuePlace || 'ADDIS ABABA').toUpperCase(),
    expiry: isoDate(p?.passport_expiry_date),
    phone: phone || String(settings.phone || '').replace(/\D/g, ''),
    email: settings.email || '',
  }
}

/** What Tasheer cannot take her without. The visa must be made (E.No). */
export function missingForTasheer(p, settings = {}) {
  const r = tasheerRow(p, settings)
  const need = { eno: 'visa application number (make the visa first)', first: 'name', last: 'last name', passport: 'passport number', dob: 'date of birth', issued: 'passport issue date', gender: 'gender', expiry: 'passport expiry date' }
  return Object.entries(need).filter(([k]) => !r[k]).map(([, label]) => label)
}

// ── The Excel (Tasheer's template: Bio_Applicant_Details + its hidden list) ──
const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function zip(files) {
  const parts = [], central = []
  let off = 0
  for (const [name, text] of files) {
    const n = Buffer.from(name), d = Buffer.from(text, 'utf8'), crc = zlib.crc32(d)
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6)
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26)
    parts.push(h, n, d)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42)
    central.push(c, n)
    off += 30 + n.length + d.length
  }
  const cd = Buffer.concat(central)
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, e])
}

// Each column of Tasheer's sheet (and of its Option 2 grid) by its heading.
const DATES = new Set(['dob', 'issued', 'expiry'])
export function columnKey(h) {
  const t = String(h || '').toLowerCase().replace(/[*:.]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (/^e ?no\b|^e ?number|application ?n(o|umber)/.test(t)) return 'eno'
  if (/first/.test(t)) return 'first'
  if (/second|middle|father/.test(t)) return 'second'
  if (/last|family|surname/.test(t)) return 'last'
  if (/passport/.test(t)) return 'passport'
  if (/birth/.test(t)) return 'dob'
  if (/national/.test(t)) return 'nationality'
  if (/place/.test(t)) return 'place'
  if (/issue/.test(t)) return 'issued'
  if (/expir/.test(t)) return 'expiry'
  if (/gender|sex/.test(t)) return 'gender'
  if (/mobile|phone/.test(t)) return 'phone'
  if (/mail/.test(t)) return 'email'
  return ''
}
/** A value as the template's own list spells it (MALE / Male / M; Ethiopia). */
export function asListed(key, v, lists) {
  const list = lists?.[key]
  if (!v || !list?.length) return v
  const low = String(v).toLowerCase()
  return list.find(o => o.toLowerCase() === low) || (key === 'gender' ? list.find(o => o[0]?.toLowerCase() === low[0]) : null) || v
}
const col = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26))

/**
 * The Excel. `layout` is what the template downloaded from Tasheer says
 * (readTemplate): its headings in its order, and its dropdown lists. Without
 * it, the template as it was on 2026-11-10.
 */
export function tasheerXlsx(profiles, settings = {}, layout = null) {
  const strings = [], index = new Map()
  const si = (s) => { s = String(s ?? ''); if (!index.has(s)) { index.set(s, strings.length); strings.push(s) } return index.get(s) }
  const str = (ref, v, st = 0) => `<c r="${ref}" s="${st}" t="s"><v>${si(v)}</v></c>`
  const num = (ref, v, st = 0) => v === '' || v == null ? str(ref, '', st) : `<c r="${ref}" s="${st}"><v>${v}</v></c>`
  const head = layout?.head?.length ? layout.head : HEAD
  const keys = head.map(columnKey)
  const rows = [`<row r="1">${head.map((h, i) => str(`${col(i)}1`, h, 1)).join('')}</row>`]
  profiles.forEach((p, k) => {
    const r = tasheerRow(p, settings), n = k + 2
    rows.push(`<row r="${n}">` + keys.map((key, i) => {
      const ref = `${col(i)}${n}`, v = key ? asListed(key, r[key], layout?.lists) : ''
      if (DATES.has(key)) return v ? num(ref, serial(v), 2) : str(ref, '')
      if (key === 'phone' && /^\d+$/.test(v)) return num(ref, v)
      return str(ref, v)
    }).join('') + '</row>')
  })
  const WIDTHS = head === HEAD ? WIDTHS0 : head.map(h => Math.max(10, String(h).length + 2))
  const sheet1 = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${col(head.length - 1)}${profiles.length + 1}" /><sheetViews><sheetView workbookViewId="0" /></sheetViews><sheetFormatPr defaultRowHeight="15" /><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData><headerFooter /></worksheet>`
  const sheet2 = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A${COUNTRIES.length}" /><sheetViews><sheetView workbookViewId="0" /></sheetViews><sheetFormatPr defaultRowHeight="15" /><sheetData>${COUNTRIES.map((c, i) => `<row r="${i + 1}">${str(`A${i + 1}`, c)}</row>`).join('')}</sheetData></worksheet>`
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t>${x(s)}</t></si>`).join('')}</sst>`
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/xml" Extension="xml"/><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" PartName="/xl/workbook.xml" /><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/xl/worksheets/sheet1.xml" /><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" PartName="/xl/styles.xml" /><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/xl/worksheets/sheet2.xml" /><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" PartName="/xl/sharedStrings.xml" /></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="utf-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><bookViews><workbookView /></bookViews><sheets><sheet name="Bio_Applicant_Details" sheetId="1" r:id="rId1" /><sheet name="hiddenSheet" sheetId="2" r:id="rId3" state="veryHidden" /></sheets><calcPr fullCalcOnLoad="1" fullPrecision="1" /></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="utf-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-MM-dd" /></numFmts><fonts count="2"><font><sz val="11" /><name val="Calibri" /></font><font><b /><sz val="11" /><name val="Calibri" /></font></fonts><fills count="3"><fill><patternFill patternType="none" /></fill><fill><patternFill patternType="gray125" /></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD3D3D3" /></patternFill></fill></fills><borders count="1"><border><left /><right /><top /><bottom /><diagonal /></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" /></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" xfId="0" /><xf numFmtId="0" fontId="1" applyFont="1" fillId="2" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" /></xf><xf numFmtId="164" applyNumberFormat="1" fontId="0" /></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0" /></cellStyles><dxfs count="0" /></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet1],
    ['xl/worksheets/sheet2.xml', sheet2],
    ['xl/sharedStrings.xml', sst],
  ])
}

/** The agency's own settings the sheet uses (email, place of issue). */
export async function tasheerSettings(db) {
  const rows = await db('settings').whereIn('key', ['agency_email', 'wafid_issue_place', 'agency_phone']).catch(() => [])
  const get = (k) => String(rows.find(r => r.key === k)?.value || '').trim()
  return { email: get('agency_email'), issuePlace: get('wafid_issue_place') || 'ADDIS ABABA', phone: get('agency_phone') }
}

// ── The site ────────────────────────────────────────────────────────────────
const hasPassword = (page) => page.evaluate(() => [...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null)).catch(() => false)

function fillLogin(page, user, pass) {
  return page.evaluate((user, pass) => {
    const seen = (e) => e.offsetParent !== null
    const pw = [...document.querySelectorAll('input[type="password"]')].find(seen)
    if (!pw) return false
    const name = [...document.querySelectorAll('input')].filter(i => seen(i) && /^(text|email|tel|)$/i.test(i.type) && (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)).pop()
    const set = (el, v) => {
      if (!el) return
      el.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      for (const t of ['input', 'change', 'keyup']) el.dispatchEvent(new Event(t, { bubbles: true }))
      el.blur()
    }
    set(name, user); set(pw, pass)
    return !!(name?.value && pw.value)
  }, user, pass)
}

// ── "Concurrent Login" (asked on 2026-11-19) ────────────────────────────────
// After the first name, password and captcha Tasheer always says "You are
// already logged in from another location or device … Click 'Submit' to
// continue" (green SUBMIT, blue CLOSE; behind it "Login failure. User is
// already logged in"). The person already pressed LOGIN, so Adal Keep presses
// SUBMIT itself if the person has not within a moment; then the form comes
// back empty: the same name and password go in again, the person types only a
// new captcha (if one shows), and LOGIN is pressed as soon as it is typed.
const onTasheerSite = (page) => { try { return /(^|\.)tasheer\.com$/i.test(new URL(page.url()).hostname) || !!page.__adalTasheerMock } catch { return false } }
/** The Concurrent Login dialog's SUBMIT, marked data-adal-concurrent; false when it is not up. */
export function concurrentShown(page) {
  return page.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const re = /concurrent\s*login|already\s*logged\s*in\s*from|previous\s*session\s*must\s*be\s*terminated/i
    const btn = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]')]
      .filter(b => seen(b) && /^\s*submit\s*$/i.test(b.innerText || b.value || ''))
      .find(b => { for (let e = b.parentElement, i = 0; e && i < 8; e = e.parentElement, i++) if (re.test(e.innerText || '')) return e !== document.body; return false })
    document.querySelectorAll('[data-adal-concurrent]').forEach(e => e.removeAttribute('data-adal-concurrent'))
    if (!btn) return false
    btn.setAttribute('data-adal-concurrent', '1')
    return true
  }).catch(() => false)
}
/** What captcha the sign-in shows: none, a box the person types into, or a widget. */
function captchaState(page) {
  return page.evaluate(() => {
    const seen = (e) => e.offsetParent !== null
    const token = document.querySelector('textarea[name="g-recaptcha-response"], input[name="cf-turnstile-response"]')
    if (token && document.querySelector('iframe[src*="recaptcha"], iframe[src*="turnstile"], .g-recaptcha, .cf-turnstile')) return { kind: 'widget', value: token.value || '' }
    const box = [...document.querySelectorAll('input')].find(i => seen(i) && !/^(hidden|password|checkbox|radio|submit|button)$/i.test(i.type) &&
      /captcha|security\s*code|verification\s*code|image\s*code/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.className].join(' ')))
    return box ? { kind: 'text', value: box.value || '' } : { kind: 'none', value: '' }
  }).catch(() => ({ kind: 'none', value: '' }))
}
const pressLogin = (page) => page.evaluate(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const b = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')]
    .find(b => seen(b) && /^\s*(log\s*-?\s*in|sign\s*in)\s*$/i.test(b.innerText || b.value || ''))
  if (!b) return false
  b.click()
  return true
}).catch(() => false)

// ── The captcha by notification (asked on 2026-11-21, like the visa's) ──────
// Tasheer's captcha picture goes into a notification and a task (the PC's bar
// and the phones) with a code box; what is typed there goes into Tasheer's
// box here and LOGIN (or Confirm) is pressed. Nobody opens the Tasheer tab for
// a code. No answer in 10 minutes: the call goes and the caller pauses.
export const CODE_WAIT_MS = 10 * 60000

/** Marks Tasheer's captcha box (data-adal-tcap) and its picture (data-adal-tcap-img); the picture's src when it is a data: one. */
function markCaptcha(page) {
  return page.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    document.querySelectorAll('[data-adal-tcap], [data-adal-tcap-img]').forEach(e => { e.removeAttribute('data-adal-tcap'); e.removeAttribute('data-adal-tcap-img') })
    const box = [...document.querySelectorAll('input')].find(i => seen(i) && !/^(hidden|password|checkbox|radio|submit|button)$/i.test(i.type) &&
      /captcha|security\s*code|verification\s*code|image\s*code/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.className].join(' ')))
    if (!box) return { box: false }
    box.setAttribute('data-adal-tcap', '1')
    // A picture that drew (a broken one is no use in a notification).
    const pics = [...document.querySelectorAll('img, canvas')].filter(i => seen(i) && (i.tagName !== 'IMG' || (i.complete && i.naturalWidth > 0)))
    const named = pics.find(i => /captcha|kaptcha|securimage|verif/i.test([i.src, i.id, i.className, i.alt, i.getAttribute('name')].join(' ')))
    // Else the picture nearest the box (a captcha sits beside its box).
    const b = box.getBoundingClientRect()
    const near = pics.map(i => { const r = i.getBoundingClientRect(); return [Math.hypot(r.x + r.width / 2 - (b.x + b.width / 2), r.y + r.height / 2 - (b.y + b.height / 2)), i, r] })
      .filter(([d, , r]) => d < 300 && r.width >= 40 && r.width <= 400 && r.height >= 15 && r.height <= 150).sort((x, y) => x[0] - y[0])[0]?.[1]
    const pic = named || near
    if (!pic) return { box: true, pic: false }
    pic.setAttribute('data-adal-tcap-img', '1')
    return { box: true, pic: true, value: box.value || '', src: pic.tagName === 'IMG' && /^data:image\//.test(pic.src) ? pic.src : '' }
  }).catch(() => ({ box: false }))
}

/** The captcha picture, as a data: address for the notification, or null. */
export async function captchaImage(page) {
  const m = await markCaptcha(page)
  if (!m.pic) return null
  if (m.src) return m.src
  const el = await page.$('[data-adal-tcap-img]').catch(() => null)
  if (!el) return null
  const b64 = await el.screenshot({ encoding: 'base64' }).catch(() => null)
  return b64 ? `data:image/png;base64,${b64}` : null
}

/** The code into Tasheer's captcha box (as typed keys, so the site's own checks see it). */
async function typeCode(page, text) {
  await markCaptcha(page)
  const box = await page.$('[data-adal-tcap]').catch(() => null)
  if (!box) return false
  await page.evaluate(() => { const i = document.querySelector('[data-adal-tcap]'); if (i) { i.focus(); i.value = '' } }).catch(() => {})
  await box.type(String(text), { delay: 40 }).catch(() => {})
  await page.evaluate(() => { const i = document.querySelector('[data-adal-tcap]'); for (const t of ['input', 'change']) i?.dispatchEvent(new Event(t, { bubbles: true })) }).catch(() => {})
  return page.evaluate((t) => document.querySelector('[data-adal-tcap]')?.value === t, String(text)).catch(() => false)
}
const pressConfirm = (page) => page.evaluate(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const b = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')]
    .find(b => seen(b) && /^\s*(confirm|verify|submit)\s*$/i.test(b.innerText || b.value || ''))
  if (!b) return false
  b.click()
  return true
}).catch(() => false)

/**
 * Ask Tasheer's captcha by notification and type the answer. press: 'login'
 * (the sign-in: name and password refilled from the vault when the site
 * emptied them, LOGIN pressed) | 'confirm' | 'none'. creds: { user, pass }.
 * Returns 'typed' | 'expired' | 'gone' | 'no-picture' | 'no-asker'.
 */
export async function captchaByNotice(page, ctx, { title = 'Tasheer: type the code', press = 'login', creds = null, waitMs = CODE_WAIT_MS, gone = async () => false } = {}) {
  if (typeof ctx?.askCaptcha !== 'function') return 'no-asker'
  const pic = await captchaImage(page)
  if (!pic) return 'no-picture'
  const forget = () => { try { ctx.forgetCaptcha ? ctx.forgetCaptcha() : (ctx.runId != null && doneWith(ctx.runId, { force: true })) } catch {} }
  log(ctx, `🔔 the captcha picture is in the notification — waiting for its code (${Math.round(waitMs / 60000)} min)`)
  return new Promise((resolve) => {
    let over = false
    const finish = (v) => { if (over) return; over = true; clearTimeout(timer); clearInterval(watch); resolve(v) }
    const timer = setTimeout(() => { forget(); finish('expired') }, waitMs)
    const watch = setInterval(async () => {
      if (over) return
      if (cancelled(ctx) || page.isClosed?.() || await gone().catch(() => false)) { forget(); finish('gone') }
    }, 1500)
    ctx.askCaptcha(pic, async (text) => {
      try {
        if (!onTasheerSite(page)) { log(ctx, 'the page is not Tasheer any more — the code is not typed', 'warn'); return }
        if (press === 'login' && creds?.user && creds?.pass) {
          const empty = await page.evaluate(() => ![...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null && i.value)).catch(() => false)
          if (empty) await fillLogin(page, creds.user, creds.pass)
        }
        const ok = await typeCode(page, text)
        log(ctx, ok ? `code typed (${String(text).length} characters)` : 'the code did not stay in its box', ok ? 'info' : 'warn')
        if (press === 'login') log(ctx, (await pressLogin(page)) ? '✓ LOGIN pressed' : 'the LOGIN button was not found', 'info')
        else if (press === 'confirm') { if (await pressConfirm(page)) log(ctx, '✓ Confirm pressed') }
      } catch (e) { log(ctx, `typing the code: ${e.message}`, 'warn') } finally { finish('typed') }
    }, { title, label: 'Letters in the picture' })
  })
}

/** The sign-in form waits for a captcha code (its box empty, no Concurrent Login over it). */
async function loginCodeWanted(page) {
  if (!(await hasPassword(page)) || await concurrentShown(page)) return false
  const m = await markCaptcha(page)
  return !!(m.box && m.pic && !m.value)
}
/** A run's pause for a code nobody typed (runTasheer turns it into a clean pause). */
const codePause = () => Object.assign(new Error('Nobody typed the Tasheer code within 10 minutes'), { pauseReason: 'awaiting-tasheer-code' })

/**
 * The dialog is up: SUBMIT (the person's, or ours after `graceMs`), the same
 * name and password again, the new captcha asked by notification (`ask`, see
 * captchaByNotice: the robot types the code and presses LOGIN) — or, with no
 * `ask` or no picture, left to the person in the tab — LOGIN. Returns
 * 'logged-in-pressed' | 'no-form' | 'no-captcha-typed' | 'not-shown'.
 */
export async function afterConcurrentLogin(page, user, pass, { say = () => {}, graceMs = 2500, captchaMs = 15 * 60000, check = () => {}, ask = null } = {}) {
  if (!(await concurrentShown(page))) return 'not-shown'
  say('Tasheer says the account is already signed in elsewhere (Concurrent Login) — pressing SUBMIT to end the old session')
  for (const end = Date.now() + graceMs; Date.now() < end && await concurrentShown(page);) { check(); await sleep(500) }
  if (await concurrentShown(page)) {
    await page.evaluate(() => document.querySelector('[data-adal-concurrent]')?.click()).catch(() => {})
  }
  // The sign-in form comes back (its password box empty).
  const back = async () => !(await concurrentShown(page)) && await hasPassword(page)
  let ok = false
  for (const end = Date.now() + 30000; Date.now() < end && !(ok = await back());) { check(); await sleep(500) }
  if (!ok) { say('the sign-in form did not come back after SUBMIT', 'warn'); return 'no-form' }
  await sleep(600)
  // Only Tasheer's own password box gets the password.
  if (!onTasheerSite(page)) { say('the page is not Tasheer — the password is not typed', 'warn'); return 'no-form' }
  const filled = await fillLogin(page, user, pass)
  say(filled ? '🔐 name and password filled again' : 'the sign-in boxes were not all found again', filled ? 'info' : 'warn')
  let c = await captchaState(page)
  // The new captcha by notification: the code typed there goes in, LOGIN pressed.
  if (c.kind === 'text' && ask) {
    const r = await ask('Tasheer (Concurrent Login): type the new code')
    if (r === 'typed') return 'logged-in-pressed'
    if (r === 'expired' || r === 'gone') { say(r === 'expired' ? 'nobody typed the code within 10 minutes' : 'the sign-in page went away', 'warn'); return 'no-captcha-typed' }
    // 'no-picture' / 'no-asker': the person types it in the tab, as before.
  }
  if (c.kind !== 'none') {
    say('⏳ waiting for the person to type the new captcha — LOGIN is pressed as soon as it is typed')
    // Typed = the widget gave its token, or the box has 4+ characters that stayed the same for 2 s.
    let last = '', since = Date.now()
    const end = Date.now() + captchaMs
    for (;;) {
      check()
      if (Date.now() > end) { say('nobody typed the captcha', 'warn'); return 'no-captcha-typed' }
      if (!(await hasPassword(page))) return 'logged-in-pressed'        // the person pressed LOGIN themselves
      c = await captchaState(page)
      if (c.value !== last) { last = c.value; since = Date.now() }
      if (c.kind === 'widget' ? !!c.value : (c.value.length >= 4 && Date.now() - since >= 2000)) break
      await sleep(400)
    }
  }
  // The password box must still hold it (a page that reset the form gets it again).
  const empty = await page.evaluate(() => ![...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null && i.value)).catch(() => false)
  if (empty) await fillLogin(page, user, pass)
  if (await pressLogin(page)) say('✓ LOGIN pressed')
  else say('the LOGIN button was not found — press it', 'warn')
  return 'logged-in-pressed'
}

// Cloudflare's "Just a moment…" / "Verify you are human" before the site.
// Cloudflare's hard block ("Sorry, you have been blocked", titled "Attention Required"): no box to tick, nobody
// can pass it from this browser (seen live 2026-11-23 from a headless browser). Not a challenge: the run stops at once.
const BLOCKED = /you have been blocked|you are unable to access/i
export const blockedText = (text) => BLOCKED.test(String(text || ''))
const blocked = (page) => page.evaluate(() => document.title + ' ' + (document.body?.innerText || '').slice(0, 400)).then(blockedText).catch(() => false)
export const challengeText = (text) => !blockedText(text) && /just a moment|verify you are human|attention required|checking your browser/i.test(String(text || ''))
const challenged = (page) => page.evaluate(() => document.title + ' ' + (document.body?.innerText || '').slice(0, 400)).then(challengeText).catch(() => false)
const notAllowed = (page) => page.evaluate(() => /method\s+'?get'?\s+is not supported/i.test(document.body?.innerText || '')).catch(() => false)

/** Past Cloudflare's check: by itself, or a person ticks it (rung once). */
async function pastCloudflare(page, ctx) {
  if (!(await challenged(page))) return
  log(ctx, '⏳ Cloudflare is checking the browser')
  if (await until(async () => !(await challenged(page)), 20000, ctx)) return
  await page.bringToFront().catch(() => {})
  await ctx.notify(`🛂 ${ctx.groupTitle}: Tasheer — tick "Verify you are human"`, 'Tasheer\'s Cloudflare check is in front: tick it. Adal Keep goes on by itself.', 'warn', { login: page })
  if (!(await until(async () => !(await challenged(page)), LOGIN_WAIT_MS, ctx))) throw new Error('Tasheer\'s Cloudflare check was not passed within 30 minutes')
}

async function signIn(page, ctx) {
  const release = await signInTurn('tasheer')
  try {
    const home = async () => /group scheduling/i.test(await page.evaluate(() => document.body?.innerText || '').catch(() => ''))
    // A Tasheer tab of this run already signed in and at home: nothing to do.
    if (/tasheer\.com/i.test(page.url()) && await home()) return log(ctx, '✓ already signed in to Tasheer')
    log(ctx, 'opening Tasheer (agents.tasheer.com)')
    await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    // Until the page says what it is (its sign-in, home, Cloudflare), 2.5 s at most — was always 2.5 s.
    const shown = async () => (await blocked(page)) || (await challenged(page)) || (await hasPassword(page)) || (await home())
    for (const end = Date.now() + 2500; Date.now() < end && !(await shown());) await sleep(200)
    if (await blocked(page)) throw new Error("Tasheer's Cloudflare blocks this PC's browser (\"Sorry, you have been blocked\"): there is nothing to tick. Open agents.tasheer.com once in a normal browser on this PC, or run it from another PC or internet line")
    await pastCloudflare(page, ctx)
    if (await notAllowed(page)) await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    if (!(await until(async () => (await hasPassword(page)) || (await home()), 30000, ctx))) {
      await page.bringToFront().catch(() => {})
      await ctx.notify(`🛂 ${ctx.groupTitle}: open Tasheer's sign-in`, 'The Tasheer tab is in front but its sign-in did not show. Open the sign-in (or the home page with GROUP SCHEDULING) in that tab; Adal Keep goes on by itself.', 'warn', { login: page })
      if (!(await until(async () => (await hasPassword(page)) || (await home()), LOGIN_WAIT_MS, ctx))) throw new Error('Tasheer showed neither its sign-in page nor GROUP SCHEDULING')
    }
    if (!(await hasPassword(page))) return log(ctx, '✓ signed in to Tasheer')
    if (!ctx.tasheer_username || !ctx.tasheer_password) throw new Error('No Tasheer account — add one under AI Actions → Tasheer → Login')
    const ok = await fillLogin(page, ctx.tasheer_username, ctx.tasheer_password)
    log(ctx, ok ? `🔐 name and password filled (${ctx.tasheer_name || ctx.tasheer_username})` : 'the sign-in boxes were not all found', ok ? 'info' : 'warn')
    const creds = { user: ctx.tasheer_username, pass: ctx.tasheer_password }
    // The captcha by notification: its picture and a code box on the PC and the
    // phones; the code typed there goes in and LOGIN is pressed here.
    const ask = (title) => captchaByNotice(page, ctx, { title, press: 'login', creds, gone: async () => !(await hasPassword(page)) })
    let asked = 0, askedAt = 0
    const askLogin = async (title) => {
      asked++
      const r = await ask(title)
      askedAt = Date.now()
      if (r === 'expired') throw codePause()
      return r
    }
    const byNotice = await loginCodeWanted(page)
    if (byNotice) {
      await ctx.notify(`🛂 ${ctx.groupTitle}: Tasheer sign-in code`, 'Type the code from the picture in the notification; Adal Keep signs in to Tasheer and goes on by itself. The call goes after 10 minutes without an answer.', 'warn')
      const r = await askLogin('Tasheer sign-in: type the code')
      if (r !== 'typed') {
        await page.bringToFront().catch(() => {})
        await ctx.notify(`🛂 ${ctx.groupTitle}: sign in to Tasheer`, 'Type Tasheer\'s captcha in its tab and sign in; Adal Keep goes on by itself (GROUP SCHEDULING).', 'warn', { login: page })
      }
    } else {
      await page.bringToFront().catch(() => {})
      await ctx.notify(`🛂 ${ctx.groupTitle}: sign in to Tasheer`, 'The Tasheer tab is in front with the name and password filled. Type its captcha and sign in; Adal Keep goes on by itself (GROUP SCHEDULING).', 'warn', { login: page })
    }
    const signedInNow = async () => {
      if (await concurrentShown(page)) {
        const out = await afterConcurrentLogin(page, creds.user, creds.pass, {
          say: (m, l) => log(ctx, m, l), check: () => stop(ctx),
          ask: async (title) => { const r = await ask(title); askedAt = Date.now(); return r },
        })
        if (out === 'no-captcha-typed') throw codePause()
        return false
      }
      // A wrong code: the form comes back with a new picture and an empty box — asked again.
      if (asked && asked < 6 && Date.now() - askedAt > 6000 && await loginCodeWanted(page)) {
        log(ctx, 'Tasheer did not take the code — asking for the new one', 'warn')
        await askLogin('Not accepted: type the new Tasheer code')
        return false
      }
      return !(await hasPassword(page)) && (await home())
    }
    // until() swallows a test's errors: a code nobody typed is kept and thrown here.
    let paused = null
    const test = () => signedInNow().catch(e => { if (e.pauseReason) { paused = e; return true } throw e })
    if (!(await until(test, LOGIN_WAIT_MS, ctx))) throw new Error('Nobody signed in to Tasheer within 30 minutes')
    if (paused) throw paused
    log(ctx, '✓ signed in to Tasheer')
    // The agency's one Tasheer sign-in is now this one (every PC sees it).
    if (ctx.db) await import('./tasheerSession.js').then(s => s.robotSignedIn(ctx.db, ctx.by || '', 'the main PC')).catch(() => {})
  } finally { release() }
}

/** A <select> named by the text just before it ("VISA Type", "VSC Center", "Number of Applicants"). */
function chooseBy(page, id, labelSrc, optionSrc) {
  return page.evaluate((id, labelSrc, optionSrc) => {
    const lab = new RegExp(labelSrc, 'i'), want = new RegExp(optionSrc, 'i')
    const textBefore = (el) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let last = '', n
      while ((n = w.nextNode())) {
        if (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break
        if (n.parentElement?.closest('select, option, script, style')) continue
        if (n.parentElement && n.parentElement.offsetParent === null && getComputedStyle(n.parentElement).position !== 'fixed') continue   // hidden (the "*" of a field)
        const t = n.textContent.trim()
        if (t) last = t
      }
      return last
    }
    // Tasheer's own boxes by their id; else by the words before them.
    const sel = document.getElementById(id) || [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && lab.test(textBefore(s)))
    if (!sel) return { state: 'missing' }
    const opts = [...sel.options]
    const o = opts.find(o => want.test(o.text.trim()))
    if (!o) return { state: 'no-match', options: opts.map(o => o.text.trim()).filter(Boolean).slice(0, 12) }
    if (sel.value !== o.value) {
      sel.value = o.value; o.selected = true
      for (const t of ['input', 'change']) sel.dispatchEvent(new Event(t, { bubbles: true }))
    }
    return { state: 'ok', text: o.text.trim(), max: Math.max(0, ...opts.map(o => Number(o.text.trim()) || 0)) }
  }, id, labelSrc, optionSrc)
}

const bodyText = (page) => page.evaluate(() => document.body?.innerText || '').catch(() => '')
// The upload page (Option 1): a Choose File box and an "Upload Sheet" control —
// a button whose words may be its value (not in the page's text), in the page
// or in a frame inside it. Returns that frame, or null.
async function uploadFrame(page) {
  for (const f of page.frames()) {
    const ok = await f.evaluate(() => {
      if (!document.querySelector('input[type="file"]')) return false
      const words = [document.body?.innerText || '', ...[...document.querySelectorAll('input[type="button"], input[type="submit"], button, a')].map(e => e.value || e.innerText || '')].join(' ')
      return /upload\s*sheet/i.test(words)
    }).catch(() => false)
    if (ok) return f
  }
  return null
}
const uploadShown = async (page) => !!(await uploadFrame(page))

/** VISA Type → VSC Center → Number of Applicants on the group scheduling page; what is left for a person. */
export async function pickScheduling(page, ctx, n) {
  const left = []
  const pick = async (id, label, src, name) => {
    let r
    for (let i = 0; i < 20; i++) {          // the next list loads after the one before is chosen
      r = await chooseBy(page, id, label, src)
      if (r.state === 'ok') break
      await waitSign(page, () => true, null, 1000, { min: 300 })   // (looked at again sooner: the list may have come)
    }
    if (r.state === 'ok') { log(ctx, `✓ ${name}: ${r.text}`); await quietNet(page, 1500) }   // (the next list asked for; the 1.5 s of before at most)
    else left.push(`${name}${r.options?.length ? ` (choices: ${r.options.join(', ')})` : ''}`)
    return r
  }
  await pick('group_scheduling_visatype', '^\\s*visa\\s*type\\s*\\*?\\s*:?\\s*$', '^\\s*work\\s*$', 'VISA Type')
  await pick('group_scheduling_vscId', '^\\s*vsc\\s*cent(er|re)\\s*\\*?\\s*:?\\s*$', 'addis', 'VSC Center')
  const r = await pick('scheduling_numberOfApplicants', '^\\s*number\\s*of\\s*applicants\\s*\\*?\\s*:?\\s*$', `^\\s*${n}\\s*$`, 'Number of Applicants')
  if (r.state === 'no-match' && r.max && r.max < n) left.push(`Tasheer takes at most ${r.max} applicants at once — ${n} were selected`)

  return left
}

export async function runTasheer(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const people = ctx.group?.length ? ctx.group : [ctx.profile]
  const settings = ctx.tasheer || {}
  const lacking = people.map(p => ({ p, m: missingForTasheer(p, settings) })).filter(x => x.m.length)
  if (lacking.length) return { ok: false, step: 'preflight', error: `Missing for Tasheer: ${lacking.map(x => `${x.p.full_name} (${x.m.join(', ')})`).join('; ')}`, seconds: 0 }
  ctx.groupTitle = people.length > 1 ? `Tasheer for ${people.length}` : ctx.profileName
  page.__adalAllowImages = true
  log(ctx, `🛂 Tasheer group scheduling for ${people.length}: ${people.map(p => p.full_name).join(', ')}`)
  try { await signIn(page, ctx) } catch (e) {
    // Nobody typed the code: the run pauses cleanly (Continue signs in again).
    if (!e.pauseReason) throw e
    log(ctx, `${e.message} — the run pauses; press Continue when someone is there`, 'warn')
    return { ok: true, pauseReason: e.pauseReason, seconds: secs() }
  }

  // GROUP SCHEDULING
  let clicked = true
  if (!/agentGroupScheduling/i.test(page.url())) {
    await until(async () => /group scheduling/i.test(await bodyText(page)), 30000, ctx)
    clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a, button, div, span, p, td')].filter(e => /^\s*group scheduling\s*$/i.test(e.innerText || '') && e.offsetParent !== null).pop()
      if (!el) return false
      ;(el.closest('a, button, [onclick]') || el).click()
      return true
    }).catch(() => false)
    if (!clicked) {
      await page.bringToFront().catch(() => {})
      await ctx.notify(`🛂 ${ctx.groupTitle}: press GROUP SCHEDULING on Tasheer`, 'Adal Keep could not find GROUP SCHEDULING on the page: press it in the Tasheer tab; it goes on by itself.', 'warn', { login: page })
    } else log(ctx, '✓ GROUP SCHEDULING')
  }
  if (!(await until(async () => /visa\s*type/i.test(await bodyText(page)) && /vsc\s*cent(er|re)/i.test(await bodyText(page)), clicked ? 60000 : LOGIN_WAIT_MS, ctx))) throw new Error('The group scheduling page (VISA Type, VSC Center) did not open')
  await quietNet(page, 1500)

  // VISA Type → VSC Center → Number of Applicants (each may reload the next list).
  const left = await pickScheduling(page, ctx, people.length)

  await ctx.noteProfile?.('Tasheer: group scheduling filled — waiting for a person to choose the day and time and press Submit').catch?.(() => {})
  await page.bringToFront().catch(() => {})
  await ctx.notify(`🛂 ${ctx.groupTitle}: choose the day and time on Tasheer`,
    (left.length ? `Still to choose: ${left.join('; ')}. ` : 'VISA Type Work, VSC Center Addis Ababa and the number of applicants are chosen. ') +
    'Type the captcha and Confirm, pick the day and the time (Confirm Slot) and press Submit. Adal Keep then uploads the Excel by itself.', 'warn', { login: page })

  // The person presses Submit: the upload page (Option 1) comes.
  log(ctx, '⏳ waiting for the day, the time and Submit')
  // A captcha on the scheduling page (before Confirm) comes by notification
  // too: typed here and Confirm pressed. Not answered in 10 minutes: it is left
  // to the person, who is in the tab for the day and the time anyway.
  let pickAsks = 0
  const pickWatch = async () => {
    if (await uploadShown(page)) return true
    if (pickAsks < 3 && !(await hasPassword(page))) {
      const m = await markCaptcha(page)
      if (m.box && m.pic && !m.value) {
        pickAsks++
        const r = await captchaByNotice(page, ctx, { title: 'Tasheer appointment: type the code', press: 'confirm', gone: async () => uploadShown(page) })
        if (r === 'expired') { pickAsks = 3; log(ctx, 'nobody typed the code within 10 minutes — type it in the Tasheer tab', 'warn') }
      }
    }
    return false
  }
  if (!(await until(pickWatch, PICK_WAIT_MS, ctx))) throw new Error('Nobody pressed Submit on Tasheer within an hour')
  log(ctx, '✓ the upload page is open')
  await quietNet(page, 1500)
  const frame = (await uploadFrame(page)) || page.mainFrame()
  return uploadAndSave(page, frame, people, settings, ctx, secs)
}

// ── The template (Step 1 "Download Excel Template"), read here ─────────────
/** The files of an .xlsx (a zip): name → Buffer. */
export function unzip(buf) {
  const out = new Map()
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) return out
  let p = buf.readUInt32LE(e + 16)
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20)
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8')
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const data = buf.subarray(start, start + size)
    try { out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)) } catch {}
    p += 46 + nl + xl + cl
  }
  return out
}
const unx = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
/** A sheet's cells: { A1: 'E.No', … } (shared strings and inline strings read). */
function cells(xml, sst) {
  const out = {}
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /\br="([A-Z]+\d+)"/.exec(m[1])?.[1]
    if (!ref || !m[2]) continue
    const t = /\bt="(\w+)"/.exec(m[1])?.[1]
    const v = /<v>([\s\S]*?)<\/v>/.exec(m[2])?.[1]
    if (t === 's') out[ref] = sst[Number(v)] ?? ''
    else if (t === 'inlineStr') out[ref] = unx([...m[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''))
    else if (v != null) out[ref] = unx(v)
  }
  return out
}
/**
 * What a Tasheer template says: { head: [the headings in order], lists:
 * { gender: [...], nationality: [...] }, sheet }. Its dropdowns are data
 * validations: an inline list ("MALE,FEMALE") or a range of its hidden sheet.
 */
export function readTemplate(buf) {
  const files = unzip(buf)
  const text = (n) => files.get(n)?.toString('utf8') || ''
  const sst = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unx([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')))
  const wb = text('xl/workbook.xml'), rels = text('xl/_rels/workbook.xml.rels')
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)].map(m => {
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels)
    const t = (target?.[1] || target?.[2] || '').replace(/^\/?xl\//, '').replace(/^\//, '')
    return { name: unx(m[1]), path: `xl/${t}` }
  })
  if (!sheets.length) return null
  const first = text(sheets[0].path)
  const c = cells(first, sst)
  const head = []
  for (let i = 0; i < 60; i++) { const v = c[`${col(i)}1`]; if (v == null || v === '') { if (i > 0 && head.length === i) break; else continue } head[i] = String(v).trim() }
  const lists = {}
  for (const m of first.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
    const sq = /sqref="([A-Z]+)\d+/.exec(m[1])?.[1]
    const f = unx(/<formula1>([\s\S]*?)<\/formula1>/.exec(m[2])?.[1] || '')
    if (!sq) continue
    const idx = [...Array(head.length).keys()].find(i => col(i) === sq)
    const key = idx == null ? '' : columnKey(head[idx])
    if (!key) continue
    let vals = []
    if (/^".*"$/.test(f)) vals = f.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    else {
      const r = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(f)
      const sh = r && sheets.find(s => s.name === r[1])
      if (sh) { const sc = cells(text(sh.path), sst); for (let n = Number(r[3]); n <= Number(r[5]); n++) if (sc[`${r[2]}${n}`]) vals.push(String(sc[`${r[2]}${n}`]).trim()) }
    }
    if (vals.length) lists[key] = vals
  }
  return { head: head.map(h => h || ''), lists, sheet: sheets[0].name }
}
/** The template against what Adal Keep makes: same headings in the same order? */
export function compareTemplate(tpl) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '')
  const same = tpl.head.length === HEAD.length && tpl.head.every((h, i) => norm(h) === norm(HEAD[i]))
  const unknown = tpl.head.filter(h => h && !columnKey(h))
  const keys = tpl.head.map(columnKey)
  const lacking = ['eno', 'first', 'last', 'passport', 'dob', 'nationality', 'issued', 'gender', 'expiry'].filter(k => !keys.includes(k))
  const values = []
  if (tpl.lists.nationality && !tpl.lists.nationality.some(v => /^ethiopia$/i.test(v))) values.push('Ethiopia is not in its nationality list')
  if (tpl.lists.gender && !tpl.lists.gender.some(v => /^f/i.test(v))) values.push(`its gender list is ${tpl.lists.gender.join('/')}`)
  return { same, unknown, lacking, values }
}

/** Step 1's template, fetched inside the signed-in page (its link), or null. */
async function downloadTemplate(frame) {
  const got = await frame.evaluate(async () => {
    const a = [...document.querySelectorAll('a[href]')].find(a => /download\s*(excel\s*)?template|template/i.test((a.innerText || a.title || '') + ' ' + a.getAttribute('href')) && /^https?:/i.test(a.href))
    if (!a) return { why: 'its link is not a plain address' }
    const r = await fetch(a.href, { credentials: 'include' })
    if (!r.ok) return { why: `the site answered ${r.status}` }
    const b = new Uint8Array(await r.arrayBuffer())
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
    return { b64: btoa(s) }
  }).catch(e => ({ why: e.message }))
  if (!got?.b64) return { why: got?.why || 'not found' }
  const buf = Buffer.from(got.b64, 'base64')
  if (buf.readUInt32LE(0) !== 0x04034b50) return { why: 'what came back is not an Excel file' }
  return { tpl: readTemplate(buf) }
}

// ── The upload page: Upload Sheet, the grid, the site's words, Save ────────
/** What the dialog shows now (read in the frame). */
function uploadState(frame, passports) {
  return frame.evaluate((passports) => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' }
    const words = (e) => (e.innerText || e.value || '').replace(/\s+/g, ' ').trim()
    const off = (b) => !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled') || getComputedStyle(b).pointerEvents === 'none' || b.closest('fieldset[disabled]'))
    // The site's own words: alerts, toasts, sweetalerts, red text under a box.
    const msgs = [...document.querySelectorAll('.error, .alert, .ui-messages, .ui-growl, [role="alert"], .text-danger, .msg, .swal2-popup, .swal-modal, .sweet-alert, .toast, .toast-message, .noty_body, .bootbox, .jconfirm-box, .invalid-feedback, label.error, .help-block, .errorMsg, .error-message, .validation-summary-errors, .field-validation-error')]
      .filter(e => seen(e) && words(e) && !e.closest('[data-adal-skip]')).map(words)
    const uniq = [...new Set(msgs)].filter((m, i, a) => !a.some((o, j) => j !== i && o.length > m.length && o.includes(m)))
    const bad = uniq.filter(m => /error|invalid|wrong|not\s+valid|incorrect|fail|mismatch|format|required|must|duplicate|exceed|not\s+allowed|not\s+match|please|unable|cannot|can't|empty/i.test(m))
    const good = uniq.filter(m => !bad.includes(m) && /success|uploaded|saved|booked|confirmed|reference|thank/i.test(m))
    // The grid (Option 2): the table whose heading has Passport Number.
    const table = [...document.querySelectorAll('table')].find(t => /passport/i.test(t.querySelector('thead, tr')?.innerText || ''))
    let rows = 0, found = []
    if (table) {
      const body = [...table.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('td'))
      for (const tr of body) {
        const vals = [...tr.querySelectorAll('td')].map(td => [td.innerText, ...[...td.querySelectorAll('input, select, textarea')].map(i => i.tagName === 'SELECT' ? i.options[i.selectedIndex]?.text : i.value)].join(' ')).join(' ').toUpperCase()
        if (vals.replace(/[^A-Z0-9]/g, '').length > 3) rows++
        for (const p of passports) if (vals.includes(p)) found.push(p)
      }
    }
    const save = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]')].filter(b => seen(b) && /^\s*save\s*$/i.test(words(b)))
    save.forEach(b => b.setAttribute('data-adal-save', '1'))
    const saveOn = save.some(b => !off(b))
    const text = document.body?.innerText || ''
    return { bad, good, rows, found: [...new Set(found)], grid: !!table, save: save.length > 0, saveOn,
      slot: /select\s+(a\s+)?(time\s*)?slot|available\s+slots?|choose\s+(a\s+)?(time\s*)?slot/i.test(text) }
  }, passports).catch(() => ({ bad: [], good: [], rows: 0, found: [], grid: false, save: false, saveOn: false, slot: false }))
}
const ERRORISH = /error|invalid|wrong|not\s+valid|incorrect|fail|mismatch|format|required|must|duplicate|exceed|not\s+allowed|not\s+match|unable|cannot|can't|empty/i

/** The "Upload Sheet" control, marked data-adal-upload (the one nearest after the file box). */
function markUploadButton(frame) {
  return frame.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const own = (e) => (e.value || e.innerText || e.title || '').replace(/\s+/g, ' ').trim()
    const all = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"], label, span, div[onclick], i[onclick]')]
      .filter(e => seen(e) && /^\s*(\S+\s*)?upload\s*sheet\s*$/i.test(own(e)))
      .map(e => e.closest('button, a, [role="button"], [onclick]') || e)
    document.querySelectorAll('[data-adal-upload]').forEach(e => e.removeAttribute('data-adal-upload'))
    if (!all.length) return { found: false }
    const file = document.querySelector('input[type="file"]')
    const after = file ? all.filter(e => file.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) : []
    const b = after[0] || all[0]
    b.setAttribute('data-adal-upload', '1')
    return { found: true, disabled: !!(b.disabled || b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true') }
  }).catch(() => ({ found: false }))
}

/** Option 2: the grid's boxes filled from her profile (only when Option 1 cannot be). */
function fillGrid(frame, rows) {
  return frame.evaluate((rows) => {
    const key = (h) => {
      const t = String(h || '').toLowerCase().replace(/[*:.]/g, ' ').replace(/\s+/g, ' ').trim()
      return /^e ?no\b|^e ?number/.test(t) ? 'eno' : /first/.test(t) ? 'first' : /second|middle|father/.test(t) ? 'second' : /last|family/.test(t) ? 'last'
        : /passport/.test(t) ? 'passport' : /birth/.test(t) ? 'dob' : /national/.test(t) ? 'nationality' : /place/.test(t) ? 'place' : /issue/.test(t) ? 'issued'
        : /expir/.test(t) ? 'expiry' : /gender|sex/.test(t) ? 'gender' : /mobile|phone/.test(t) ? 'phone' : /mail/.test(t) ? 'email' : ''
    }
    const table = [...document.querySelectorAll('table')].find(t => /passport/i.test(t.querySelector('thead, tr')?.innerText || ''))
    if (!table) return { ok: false, why: 'the grid was not found' }
    const heads = [...(table.querySelector('thead tr') || table.querySelector('tr')).querySelectorAll('th, td')].map(th => key(th.innerText))
    const body = [...table.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('input, select'))
    if (body.length < rows.length) return { ok: false, why: `the grid has ${body.length} row(s) for ${rows.length} applicant(s)` }
    const setVal = (el, v) => {
      el.focus()
      if (el.tagName === 'SELECT') {
        const low = String(v).toLowerCase()
        const o = [...el.options].find(o => o.text.trim().toLowerCase() === low || o.value.toLowerCase() === low) || [...el.options].find(o => low && o.text.trim().toLowerCase()[0] === low[0] && /gender|sex/i.test(el.name + el.id))
        if (!o) return false
        el.value = o.value
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      }
      for (const t of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }))
      return true
    }
    const date = (el, iso) => {
      if (!iso || el.type === 'date') return iso
      const [y, m, d] = iso.split('-')
      const ph = (el.placeholder || el.getAttribute('data-date-format') || '').toLowerCase()
      return /^dd[/-]mm[/-]yyyy/.test(ph) ? `${d}${ph[2]}${m}${ph[2]}${y}` : /^mm[/-]dd[/-]yyyy/.test(ph) ? `${m}${ph[2]}${d}${ph[2]}${y}` : iso
    }
    const missed = []
    rows.forEach((r, k) => {
      const tds = [...body[k].querySelectorAll('td')]
      heads.forEach((h, i) => {
        if (!h || !r[h] || !tds[i]) return
        const el = tds[i].querySelector('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')
        if (!el) return
        const v = ['dob', 'issued', 'expiry'].includes(h) ? date(el, r[h]) : r[h]
        if (!setVal(el, v)) missed.push(`${h} of row ${k + 1}`)
      })
    })
    return { ok: !missed.length, why: missed.length ? `could not set ${missed.join(', ')}` : '' }
  }, rows).catch(e => ({ ok: false, why: e.message }))
}

/** The consent box ("By clicking here I indicate that, I have the permission …") ticked. */
function tickConsent(frame) {
  return frame.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
    const box = boxes.find(b => /permission|consent|privacy|i\s+indicate|agree/i.test((b.closest('label, p, div, td, tr') || b.parentElement)?.innerText || '')) || boxes[boxes.length - 1]
    if (!box) return false
    box.scrollIntoView({ block: 'center' })
    if (!box.checked) box.click()
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
    return box.checked
  }).catch(() => false)
}

const UPLOAD_WAIT_MS = 90 * 1000
const SAVE_WAIT_MS = 90 * 1000

/**
 * After Submit: the Excel (checked against the site's own template) chosen,
 * Upload Sheet pressed and its answer awaited (rows filled / Save enabled /
 * the site's error), the consent ticked, Save pressed, its confirmation
 * answered, and a time-slot step (if it comes) handed to the person.
 * One try: no step is done twice except pressing Upload Sheet once more
 * when the first press drew no answer at all.
 */
export async function uploadAndSave(page, frame, people, settings, ctx, secs = () => 0) {
  const passports = people.map(p => tasheerRow(p, settings).passport)
  const siteSaid = []                      // every word the site gave, for the report
  const dialogs = []
  const onDialog = (d) => {
    if (d.type() === 'beforeunload') return
    if (d.type() !== 'confirm') dialogs.push(d.message())     // "Are you sure?" is a question, not an answer
    log(ctx, `Tasheer says (pop-up): ${d.message()}`, /error|invalid|wrong|fail|not/i.test(d.message()) ? 'warn' : 'info')
    d.accept().catch(() => {})
  }
  page.on('dialog', onDialog)
  const rang = async (title, body) => { await ctx.notify(`🛂 ${ctx.groupTitle}: ${title}`, body, 'warn', { login: page }) }
  const pause = async (title, body) => {
    await rang(title, body)
    return { ok: true, pauseReason: 'awaiting-tasheer-save', seconds: secs() }
  }
  const note = async (line) => {
    if (!ctx.db) return
    for (const p of people) {
      const row = await ctx.db('profiles').where('id', p.id).first('notes').catch(() => null)
      await ctx.db('profiles').where('id', p.id).update({ notes: [row?.notes, `[${new Date().toISOString().slice(0, 10)}] ${line}`].filter(Boolean).join('\n'), updated_at: new Date().toISOString() }).catch(() => {})
    }
  }
  // Words on the page before a press (help text, a red "*") are not its answer.
  let seenBefore = new Set()
  const fresh = (s) => {
    const pop = dialogs.splice(0)
    return {
      ...s,
      bad: [...s.bad.filter(m => !seenBefore.has(m)), ...pop.filter(m => ERRORISH.test(m))],
      good: [...s.good.filter(m => !seenBefore.has(m)), ...pop.filter(m => !ERRORISH.test(m))],
    }
  }
  const baseline = async (f) => { const b = await uploadState(f, passports); seenBefore = new Set([...b.bad, ...b.good]) }
  try {
    // 1. The template: the site's own, read, compared with ours.
    let layout = null
    const dl = await downloadTemplate(frame)
    if (dl.tpl?.head?.some(Boolean)) {
      const cmp = compareTemplate(dl.tpl)
      if (cmp.lacking.length) log(ctx, `⚠ Tasheer's template has no ${cmp.lacking.join(', ')} column — its headings: ${dl.tpl.head.join(' | ')}`, 'warn')
      if (cmp.same) log(ctx, '✓ the Excel matches Tasheer\'s template (same columns, same order)')
      else { layout = dl.tpl; log(ctx, `⚠ Tasheer's template changed — the Excel follows it: ${dl.tpl.head.join(' | ')}${cmp.unknown.length ? ` (left empty: ${cmp.unknown.join(', ')})` : ''}`, 'warn') }
      if (Object.keys(dl.tpl.lists).length) layout = { head: layout?.head || HEAD, lists: dl.tpl.lists }
      for (const v of cmp.values) log(ctx, `⚠ Tasheer's template: ${v}`, 'warn')
    } else log(ctx, `the template was not read (${dl.why}) — the Excel uses Tasheer's template as of 2026-11-10`)

    // 2. The Excel chosen in Step 3 "Select File".
    const file = path.join(os.tmpdir(), `Tasheer_${new Date().toISOString().slice(0, 10)}_${ctx.runId || Date.now()}.xlsx`)
    fs.writeFileSync(file, tasheerXlsx(people, settings, layout))
    const input = await frame.evaluateHandle(() => [...document.querySelectorAll('input[type="file"]')].find(i => i.offsetParent !== null || i.getBoundingClientRect().width > 0) || document.querySelector('input[type="file"]'))
    const el = input.asElement()
    let s = await uploadState(frame, passports)
    let option1 = !!el
    let why1 = el ? '' : 'the Select File box was not found'
    if (el) {
      await el.uploadFile(file)
      await el.evaluate(i => { i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
      log(ctx, `✓ Excel chosen: ${path.basename(file)} (${people.length} applicant${people.length === 1 ? '' : 's'})`)
    }

    // 3. Upload Sheet, and the site's answer.
    if (option1) {
      let b = { found: false }
      await pollUntil(async () => (b = await markUploadButton(frame)).found, 10000, 1000)   // (10 x 1 s polls before)
      if (!b.found) { option1 = false; why1 = 'the Upload Sheet button was not found' }
      else {
        if (b.disabled) await pollUntil(async () => { b = await markUploadButton(frame); return !b.disabled }, 10000, 1000)
        const press = async (real) => {
          const h = await frame.$('[data-adal-upload]')
          if (!h) return false
          await h.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {})
          if (real) await h.click().catch(() => h.evaluate(e => e.click()))
          else await h.evaluate(e => e.click())
          return true
        }
        await baseline(frame)
        await press(false)
        log(ctx, '✓ Upload Sheet pressed — waiting for Tasheer to read the Excel')
        const answered = (s) => s.bad.length || s.good.length || s.found.length >= people.length || s.saveOn
        let pressedAgain = false
        const t1 = Date.now()
        for (;;) {
          stop(ctx)
          s = fresh(await uploadState(frame, passports))
          if (answered(s) || Date.now() - t1 > UPLOAD_WAIT_MS) break
          // No answer at all after 20 s: the press may not have reached the page; once more, with the mouse.
          if (!pressedAgain && Date.now() - t1 > 20000) {
            pressedAgain = true
            if (await markUploadButton(frame).then(r => r.found) && await press(true)) log(ctx, 'no answer from Tasheer yet — Upload Sheet pressed once more')
          }
          await sleep(1000)
        }
        if (s.bad.length) siteSaid.push(...s.bad)
        if (s.good.length) log(ctx, `Tasheer says: ${s.good.join(' · ')}`)
        if (s.bad.length) {
          option1 = false; why1 = `Tasheer refused the Excel: ${s.bad.join(' · ')}`
          log(ctx, `✗ ${why1}`, 'warn')
        } else if (s.found.length >= people.length || s.saveOn) {
          log(ctx, `✓ Tasheer read the Excel: ${s.found.length || s.rows} of ${people.length} applicant${people.length === 1 ? '' : 's'} in the grid${s.saveOn ? ', Save enabled' : ''}`)
        } else if (!s.good.length) {
          option1 = false; why1 = `Tasheer gave no answer to Upload Sheet within ${UPLOAD_WAIT_MS / 1000} s (the grid stayed empty, Save stayed off)`
          log(ctx, `✗ ${why1}`, 'warn')
        }
      }
    }

    // 4. Option 2 (the grid) only when Option 1 could not be done.
    if (!option1) {
      log(ctx, `Option 1 could not be done (${why1}) — filling the grid (Option 2)`, 'warn')
      const g = await fillGrid(frame, people.map(p => {
        const r = tasheerRow(p, settings)
        return { ...r, gender: r.gender, nationality: r.nationality }
      }))
      await settle(1500, async () => (await uploadState(frame, passports)).found.length >= people.length)   // (was a fixed 1.5 s after the grid was filled)
      s = await uploadState(frame, passports)
      if (!g.ok || s.found.length < people.length) {
        return await pause('Tasheer — the applicants could not be put in',
          `${why1}. The grid (Option 2) could not be filled either (${g.why || `${s.found.length} of ${people.length} in it`}). ${siteSaid.length ? `Tasheer says: ${siteSaid.join(' · ')}. ` : ''}Fill the applicants in the Tasheer tab and press Save, then "✔️ Tasheer saved" on the run.`)
      }
      log(ctx, `✓ the grid filled (${s.found.length} applicant${s.found.length === 1 ? '' : 's'})`)
    }

    // 5. The consent box, then Save (enabled once the rows are in).
    if (await tickConsent(frame)) log(ctx, '✓ consent box ticked')
    else log(ctx, 'the consent box was not found', 'warn')
    await pollUntil(async () => { s = await uploadState(frame, passports); return s.saveOn }, 15000, 1000)   // (Save is only waited for, never pressed here)
    if (!s) s = await uploadState(frame, passports)
    if (s.grid && s.found.length < people.length) {
      log(ctx, `✗ only ${s.found.length} of ${people.length} applicants are in Tasheer's grid — Save not pressed`, 'warn')
      return await pause('Tasheer — look the applicants over',
        `Only ${s.found.length} of ${people.length} applicants are in Tasheer's grid${siteSaid.length ? ` (Tasheer says: ${siteSaid.join(' · ')})` : ''}. Put them right and press Save, then "✔️ Tasheer saved" on the run.`)
    }
    if (!s.saveOn) {
      s = fresh(s)
      const said = [...siteSaid, ...s.bad].join(' · ')
      log(ctx, `✗ Save stayed off${said ? ` — Tasheer says: ${said}` : ''}`, 'warn')
      return await pause('Tasheer — Save is off', `The applicants are in, but Tasheer kept Save off${said ? ` (Tasheer says: ${said})` : ''}. Look it over in the Tasheer tab and press Save, then "✔️ Tasheer saved" on the run.`)
    }
    await baseline(frame)
    const slotBefore = s.slot
    await frame.evaluate(() => { const b = document.querySelector('[data-adal-save]'); b?.scrollIntoView({ block: 'center' }); b?.click() })
    log(ctx, '✓ Save pressed')

    // 6. Its confirmation ("Are you sure?"), then success / an error / a time slot.
    const answerIn = async () => {
      const frames = [...new Set([page.frames().includes(frame) ? frame : null, page.mainFrame(), ...page.frames()].filter(Boolean))]
      const all = { bad: [], good: [], slot: false }
      for (const f of frames) { const x = await uploadState(f, passports); all.bad.push(...x.bad); all.good.push(...x.good); all.slot ||= x.slot }
      return fresh(all)
    }
    const confirmUp = (f) => f.evaluate(() => /are\s+you\s+sure|do\s+you\s+want|please\s+confirm|confirmation/i.test([...document.querySelectorAll('.modal, [role="dialog"], .swal2-popup, .swal-modal, .sweet-alert, .bootbox, .jconfirm-box')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText).join(' '))).catch(() => false)
    let out = null
    for (const end = Date.now() + SAVE_WAIT_MS; Date.now() < end && !out;) {
      stop(ctx)
      await sleep(1000)
      const a = await answerIn()
      if (a.bad.length) { out = { kind: 'error', said: a.bad.join(' · ') }; break }
      if (await confirmUp(frame) || await confirmUp(page.mainFrame())) {
        const f = await confirmUp(frame) ? frame : page.mainFrame()
        if (await clickText(f, /^\s*(yes|ok|okay|confirm|proceed|continue|submit|yes,?\s*(save|confirm))\s*$/).catch(() => false)) { log(ctx, `✓ the confirmation answered${a.good.length ? ` (${a.good.join(' · ')})` : ''}`); await sleep(1500); continue }
      }
      if (a.good.length) out = { kind: 'ok', said: a.good.join(' · ') }
      else if (a.slot && !slotBefore) out = { kind: 'slot' }
    }
    if (out?.kind === 'slot') {
      log(ctx, '⏳ Tasheer asks for a time slot — the person chooses it')
      await rang('choose the time slot on Tasheer', 'Tasheer saved the applicants and asks for a time slot: choose it in the Tasheer tab and confirm. Adal Keep goes on by itself.')
      out = null
      for (const end = Date.now() + PICK_WAIT_MS; Date.now() < end && !out;) {
        stop(ctx)
        await sleep(2000)
        const a = await answerIn()
        if (a.bad.length) out = { kind: 'error', said: a.bad.join(' · ') }
        else if (a.good.length) out = { kind: 'ok', said: a.good.join(' · ') }
      }
    }
    if (out?.kind === 'ok') {
      const ref = /(?:reference|booking|appointment)\s*(?:no\.?|number|id|#)?\s*[:#-]?\s*([A-Z]*\d[A-Z0-9-]{3,})/i.exec(out.said)?.[1] || ''
      log(ctx, `✅ Tasheer saved the group appointment${ref ? ` (reference ${ref})` : ''} — Tasheer says: ${out.said}`)
      await note(`Tasheer: group appointment (${people.length}) saved by Adal Keep${ref ? ` — reference ${ref}` : ''}. Tasheer said: ${out.said}`)
      if (ctx.db && ctx.runId) await import('./insuranceCertificate.js').then(m => m.settleMembers(ctx.db, ctx.runId, 'done')).catch(() => {})
      await Promise.resolve(ctx.notify?.(`🛂 ${ctx.groupTitle}: Tasheer appointment saved`, `Tasheer says: ${out.said}`, 'info')).catch(() => {})
      return { ok: true, done: true, seconds: secs() }
    }
    if (out?.kind === 'error') {
      log(ctx, `✗ Tasheer did not save — it says: ${out.said}`, 'warn')
      return await pause('Tasheer did not save', `After Save, Tasheer says: ${out.said}. Put it right in the Tasheer tab and press Save, then "✔️ Tasheer saved" on the run.`)
    }
    log(ctx, `Save was pressed but Tasheer showed no answer within ${SAVE_WAIT_MS / 1000} s`, 'warn')
    return await pause('Tasheer — check that it saved', 'Save was pressed, but Tasheer showed neither a success nor an error. Look at the Tasheer tab: if it saved, press "✔️ Tasheer saved" on the run; if not, press Save there.')
  } finally {
    page.off('dialog', onDialog)
  }
}

export { uploadFrame, START, hasPassword, fillLogin, loginCodeWanted, zip as _zip, HEAD as TEMPLATE_HEAD }
