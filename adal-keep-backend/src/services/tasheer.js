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
 *   3. The upload page (Option 1): the Excel made here (Tasheer's own
 *      template: Bio_Applicant_Details) is chosen and Upload Sheet pressed,
 *      the consent box ticked → rings. Save is a person's.
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

export const TASHEER = 'tasheer_schedule'
const HOME = 'https://agents.tasheer.com/AgentTasheer/auth/cnav'
const LOGIN_WAIT_MS = 30 * 60 * 1000
const PICK_WAIT_MS = 60 * 60 * 1000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = (ctx) => typeof ctx?.isCancelled === 'function' && ctx.isCancelled()
const stop = (ctx) => { if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e } }
function log(ctx, msg, level = 'info') {
  stop(ctx)
  console.log(`[tasheer] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}
async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) { stop(ctx); if (await test().catch(() => false)) return true; await sleep(1000) }
  return false
}

// Tasheer's nationality list (the template's hidden sheet).
const COUNTRIES = ["Afghanistan","Albania","Algeria","American Samoa","Andorra","Angola","Anguilla","Antarctic","Antigua","Argentina","Armenia","Aruba","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bermuda","Bhutan","Bolivia","Bosnia","Botswana","Bouvet Island","Brazil","British Indian Ocean Territory","Brunei","Bulgaria","Burkina Faso","Burundi","Cambodia","Cameroon","Canada","Cape Verde","Cayman Island","Central African Republic","Chad","Chile","China","Christmas Island","Cocos Island","Colombia","Comoros","Congo","Cook Island","Costa Rica","Cote Divoire","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominica","Dominican Republic","East Timor","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Ethiopia","Falkland Islands","Faroe Islands","Fiji","Finland","France","France Metropolitan","French Guiana","French Polynesia","French Southern and Antarctic","Gabon","Gambia","Georgia","Germany","Ghana","Gibraltar","Greece","Greenland","Grenada","Guadeloupe","Guam","Guatemala","Guinea","Guinea Bissau","Guyana","Haiti","Heard Island and McDonald Island","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Korea, North","Korea, South","Kosovo","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Macau","Macedonia, The Former Yugoslav Republic of","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Island","Martinique","Mauritania","Mauritius","Mayotte","Mexico","Micronesia, Federated Stat","Monaco","Mongolia","Montenegro","Montserrat","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","Netherlands Antilles","New Caledonia","New Zealand","Nicaragua","Niger","Nigeria","Niue","Non Bahraini","Non Emirati","Non Kuwaiti","Non Omani","Non Qatari","Norfolk Island","Northern Mariana Islands","Norway","Pakistan","Palau","Palestinian Territory Occupied","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Pitcairn Islands","Poland","Portugal","Puerto Rico","Republic of Moldova","Reunion","Romania","Russian Federation","Rwanda","Saint Kitts and Nevis","Saint Lucia","Saint Pierre and Miquelon","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome And Principe","Senegal","Serbia","Serbia and Montenegro","Seychelles","Sierra Leone","Singapore","Slovak Republic","Slovenia","Solomon Islands","Somalia","South Africa","South Georgia and The South","Spain","Sri Lanka","St Helena","Sudan","Suriname","Svalbard","Swaziland","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Thailand","Togo","Tokelau","Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Turks and Caicos Islands","Tuvalu","Uganda","Ukraine","United Kingdom","United States","United States Minor Outlying Islands","UR Tanzania","Uruguay","Uzbekistan","Vanuatu","Vatican City State","Venezuela","Vietnam","Virgin Islands","Virgin Islands US","Wallis and Futuna","Yemen","Yugoslavia","Zaire","Zambia","Zimbabwe"]

const HEAD = ['E.No', 'First Name*', 'Second Name', 'Last Name*', 'Passport Number*', 'Date of Birth*', 'Nationality*', 'Date of Issue*', 'Gender*', 'Place of Issue*', 'Expiry Date*', 'Applicant Mobile No.*', 'Email ID*']
const WIDTHS = [11.6, 12.1, 13, 11.2, 17.4, 13.3, 11.8, 13.4, 9.1, 15.1, 12, 20.8, 22.8]

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

export function tasheerXlsx(profiles, settings = {}) {
  const strings = [], index = new Map()
  const si = (s) => { s = String(s ?? ''); if (!index.has(s)) { index.set(s, strings.length); strings.push(s) } return index.get(s) }
  const str = (ref, v, st = 0) => `<c r="${ref}" s="${st}" t="s"><v>${si(v)}</v></c>`
  const num = (ref, v, st = 0) => v === '' || v == null ? str(ref, '', st) : `<c r="${ref}" s="${st}"><v>${v}</v></c>`
  const L = 'ABCDEFGHIJKLM'
  const rows = [`<row r="1">${HEAD.map((h, i) => str(`${L[i]}1`, h, 1)).join('')}</row>`]
  profiles.forEach((p, k) => {
    const r = tasheerRow(p, settings), n = k + 2
    const date = (i, iso) => iso ? num(`${L[i]}${n}`, serial(iso), 2) : str(`${L[i]}${n}`, '')
    rows.push(`<row r="${n}">` + [
      str(`A${n}`, r.eno), str(`B${n}`, r.first), str(`C${n}`, r.second), str(`D${n}`, r.last), str(`E${n}`, r.passport),
      date(5, r.dob), str(`G${n}`, r.nationality), date(7, r.issued), str(`I${n}`, r.gender), str(`J${n}`, r.place),
      date(10, r.expiry), /^\d+$/.test(r.phone) ? num(`L${n}`, r.phone) : str(`L${n}`, r.phone), str(`M${n}`, r.email),
    ].join('') + '</row>')
  })
  const sheet1 = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:M${profiles.length + 1}" /><sheetViews><sheetView workbookViewId="0" /></sheetViews><sheetFormatPr defaultRowHeight="15" /><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData><headerFooter /></worksheet>`
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

async function signIn(page, ctx) {
  const release = await signInTurn('tasheer')
  try {
    log(ctx, 'opening Tasheer (agents.tasheer.com)')
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
    await sleep(2500)
    if (!(await hasPassword(page)) && /group scheduling/i.test(await page.evaluate(() => document.body?.innerText || '').catch(() => ''))) { log(ctx, '✓ already signed in to Tasheer'); return }
    if (!(await until(() => hasPassword(page), 30000, ctx))) {
      if (/group scheduling/i.test(await page.evaluate(() => document.body?.innerText || '').catch(() => ''))) return log(ctx, '✓ signed in to Tasheer')
      throw new Error('Tasheer showed neither its sign-in page nor GROUP SCHEDULING')
    }
    if (!ctx.tasheer_username || !ctx.tasheer_password) throw new Error('No Tasheer account — add one under AI Actions → Tasheer → Login')
    const ok = await fillLogin(page, ctx.tasheer_username, ctx.tasheer_password)
    log(ctx, ok ? `🔐 name and password filled (${ctx.tasheer_name || ctx.tasheer_username})` : 'the sign-in boxes were not all found', ok ? 'info' : 'warn')
    await page.bringToFront().catch(() => {})
    await ctx.notify(`🛂 ${ctx.groupTitle}: sign in to Tasheer`, 'The Tasheer tab is in front with the name and password filled. Type its captcha and sign in; Adal Keep goes on by itself (GROUP SCHEDULING).', 'warn', { login: page })
    if (!(await until(async () => !(await hasPassword(page)), LOGIN_WAIT_MS, ctx))) throw new Error('Nobody signed in to Tasheer within 30 minutes')
    log(ctx, '✓ signed in to Tasheer')
  } finally { release() }
}

/** A <select> named by the text just before it ("VISA Type", "VSC Center", "Number of Applicants"). */
function chooseBy(page, labelSrc, optionSrc) {
  return page.evaluate((labelSrc, optionSrc) => {
    const lab = new RegExp(labelSrc, 'i'), want = new RegExp(optionSrc, 'i')
    const textBefore = (el) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let last = '', n
      while ((n = w.nextNode())) {
        if (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break
        if (n.parentElement?.closest('select, option, script, style')) continue
        const t = n.textContent.trim()
        if (t) last = t
      }
      return last
    }
    const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && lab.test(textBefore(s)))
    if (!sel) return { state: 'missing' }
    const opts = [...sel.options]
    const o = opts.find(o => want.test(o.text.trim()))
    if (!o) return { state: 'no-match', options: opts.map(o => o.text.trim()).filter(Boolean).slice(0, 12) }
    if (sel.value !== o.value) {
      sel.value = o.value; o.selected = true
      for (const t of ['input', 'change']) sel.dispatchEvent(new Event(t, { bubbles: true }))
    }
    return { state: 'ok', text: o.text.trim(), max: Math.max(0, ...opts.map(o => Number(o.text.trim()) || 0)) }
  }, labelSrc, optionSrc)
}

const bodyText = (page) => page.evaluate(() => document.body?.innerText || '').catch(() => '')
const uploadShown = (page) => page.evaluate(() => {
  const f = [...document.querySelectorAll('input[type="file"]')].find(i => i.offsetParent !== null || i.getBoundingClientRect().width > 0)
  return !!f && /upload sheet/i.test(document.body?.innerText || '')
}).catch(() => false)

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
  await signIn(page, ctx)

  // GROUP SCHEDULING
  if (!/agentGroupScheduling/i.test(page.url())) {
    if (!(await until(async () => /group scheduling/i.test(await bodyText(page)), 30000, ctx))) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a, button, div, span, p, td')].filter(e => /^\s*group scheduling\s*$/i.test(e.innerText || '') && e.offsetParent !== null).pop()
      if (!el) return false
      ;(el.closest('a, button, [onclick]') || el).click()
      return true
    }).catch(() => false)
    if (!clicked) await page.goto('https://agents.tasheer.com/AgentTasheer/auth/agentGroupScheduling', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    log(ctx, '✓ GROUP SCHEDULING')
  }
  if (!(await until(async () => /visa\s*type/i.test(await bodyText(page)) && /vsc\s*center/i.test(await bodyText(page)), 60000, ctx))) throw new Error('The group scheduling page (VISA Type, VSC Center) did not open')
  await sleep(1500)

  // VISA Type → VSC Center → Number of Applicants (each may reload the next list).
  const left = []
  const pick = async (label, src, name) => {
    let r
    for (let i = 0; i < 10; i++) {
      r = await chooseBy(page, label, src)
      if (r.state === 'ok') break
      await sleep(1000)
    }
    if (r.state === 'ok') { log(ctx, `✓ ${name}: ${r.text}`); await sleep(1500) }
    else left.push(`${name}${r.options?.length ? ` (choices: ${r.options.join(', ')})` : ''}`)
    return r
  }
  await pick('^\\s*visa\\s*type\\s*\\*?\\s*:?\\s*$', '^\\s*work\\s*$', 'VISA Type')
  await pick('^\\s*vsc\\s*cent(er|re)\\s*\\*?\\s*:?\\s*$', 'addis', 'VSC Center')
  const r = await pick('^\\s*number\\s*of\\s*applicants\\s*\\*?\\s*:?\\s*$', `^\\s*${people.length}\\s*$`, 'Number of Applicants')
  if (r.state === 'no-match' && r.max && r.max < people.length) left.push(`Tasheer takes at most ${r.max} applicants at once — ${people.length} were selected`)

  await ctx.noteProfile?.('Tasheer: group scheduling filled — waiting for a person to choose the day and time and press Submit').catch?.(() => {})
  await page.bringToFront().catch(() => {})
  await ctx.notify(`🛂 ${ctx.groupTitle}: choose the day and time on Tasheer`,
    (left.length ? `Still to choose: ${left.join('; ')}. ` : 'VISA Type Work, VSC Center Addis Ababa and the number of applicants are chosen. ') +
    'Type the captcha and Confirm, pick the day and the time (Confirm Slot) and press Submit. Adal Keep then uploads the Excel by itself.', 'warn', { login: page })

  // The person presses Submit: the upload page (Option 1) comes.
  log(ctx, '⏳ waiting for the day, the time and Submit')
  if (!(await until(() => uploadShown(page), PICK_WAIT_MS, ctx))) throw new Error('Nobody pressed Submit on Tasheer within an hour')
  log(ctx, '✓ the upload page is open')
  await sleep(1500)

  // The Excel: made here, chosen, Upload Sheet.
  const file = path.join(os.tmpdir(), `Tasheer_${new Date().toISOString().slice(0, 10)}_${ctx.runId || Date.now()}.xlsx`)
  fs.writeFileSync(file, tasheerXlsx(people, settings))
  const input = await page.evaluateHandle(() => [...document.querySelectorAll('input[type="file"]')].find(i => i.offsetParent !== null || i.getBoundingClientRect().width > 0) || document.querySelector('input[type="file"]'))
  const el = input.asElement()
  if (!el) throw new Error('The Choose File box was not found on the upload page')
  await el.uploadFile(file)
  await el.evaluate(i => { i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
  log(ctx, `✓ Excel chosen (${people.length} applicant${people.length === 1 ? '' : 's'})`)
  await sleep(1000)
  if (await clickText(page, /^\s*upload sheet\s*$/)) log(ctx, '✓ Upload Sheet pressed')
  else left.push('Upload Sheet (press it)')
  await sleep(4000)
  // A message the site gave after the upload (an error in a row), if any.
  const said = await page.evaluate(() => [...document.querySelectorAll('.error, .alert, .ui-messages, .ui-growl, [role="alert"], .text-danger, .msg')]
    .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 3).join(' · ')).catch(() => '')

  // The consent box ("By clicking here I indicate that, I have the permission …").
  const ticked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
    const box = boxes.find(b => /permission|consent|privacy/i.test((b.closest('div, td, tr, label, p') || b.parentElement)?.innerText || '')) || boxes[boxes.length - 1]
    if (!box) return false
    box.scrollIntoView({ block: 'center' })
    if (!box.checked) box.click()
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
    return box.checked
  }).catch(() => false)
  if (ticked) log(ctx, '✓ consent box ticked'); else left.push('the consent box (tick it)')

  for (const p of people) {
    const line = `[${new Date().toISOString().slice(0, 10)}] Tasheer: group appointment (${people.length}) — the Excel uploaded, waiting for a person to press Save`
    if (ctx.db) {
      const row = await ctx.db('profiles').where('id', p.id).first('notes').catch(() => null)
      await ctx.db('profiles').where('id', p.id).update({ notes: [row?.notes, line].filter(Boolean).join('\n'), updated_at: new Date().toISOString() }).catch(() => {})
    }
  }
  await page.bringToFront().catch(() => {})
  await ctx.notify(`🛂 ${ctx.groupTitle}: Tasheer — look it over and press Save`,
    `${said ? `Tasheer says: ${said}. ` : ''}${left.length ? `Still to do: ${left.join('; ')}. ` : 'The Excel is uploaded and the consent box ticked. '}Look the applicants over and press Save (Adal Keep never presses it). Then press "✔️ Tasheer saved" on the run.`, 'warn')
  log(ctx, `✅ Excel uploaded${said ? ` — Tasheer says: ${said}` : ''}`)
  return { ok: true, pauseReason: 'awaiting-tasheer-save', seconds: secs() }
}
