/**
 * musanedContracts.js — has a Saudi employer chosen her? (every 4 hours)
 *
 * For every profile that is on Musaned (a Musaned run was done, or a contract
 * was already found) and has not finished (arrived / rejected / canceled):
 *
 *   tawtheeq.musaned.com.sa/employment-requests → "Passport Number" filter →
 *   the passport → the request card. No card = nobody chose her yet.
 *   A card → DETAILS → the contract page: stage (EPRO → FMOL → Embassy → Visa
 *   → Arrived), payment, PRO, contract / visa / Tawassut numbers, employer,
 *   city of work, salary … and the PDFs at the bottom: template.pdf and the
 *   two signed contracts, saved into the profile's Contract documents.
 *
 * The first time a contract is found the profile counts as chosen and the
 * Wafid medical booking starts by itself.
 *
 * Musaned needs a signed-in Musaned in the Adal Keep Brave (captcha + OTP are
 * always a person's). Signed out → one reminder task, and the check waits.
 * Nothing on Musaned is ever changed: it only searches, reads and downloads.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getBrowser } from './browser.js'
import { setupTab } from './tabManager.js'

const SAFE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
const LIST_URL = 'https://tawtheeq.musaned.com.sa/employment-requests?sort=createdAt,DESC&page=0&size=10'
const EVERY_MS = Number(process.env.MUSANED_CHECK_HOURS || 4) * 3600 * 1000
const BETWEEN_MS = 8000
const FINAL = /ARRIVED|REJECTED|CANCELED|CANCELLED|OUTSIDE KSA/i
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Which PDF goes into which document field.
const PDF_FIELDS = [
  [/template/i, 'Contract'],
  [/PRO\s*and\s*EMPLOYER/i, 'Contract (PRO + Employer signed)'],
  [/EPRO\s*and\s*CANDIDATE/i, 'Contract (EPRO + Candidate signed)'],
]

export const contractCheck = { running: false, last: null, results: [], signedOut: false }

/** Profiles worth looking up. */
async function candidates(db, onlyId) {
  let q = db('profiles').whereNotNull('passport_number').whereNot('passport_number', '')
  if (onlyId) return q.where('id', onlyId).select('*')
  const onMusaned = db('automation_queue').where('workflow_id', 'like', 'musaned%').where('status', 'done').select('profile_id')
  return q.where(function () { this.whereIn('id', onMusaned).orWhereNotNull('contract_number') })
    .where(function () { this.whereNull('musaned_stage').orWhereNot('musaned_stage', 'like', '%ARRIVED%') })
    .select('*')
}

/**
 * Musaned passes through /login (and the Wahid sign-in) while it checks the
 * session: wait until it lands on the list, or stays on the sign-in page.
 */
async function signedIn(page) {
  const onList = () => /tawtheeq\.musaned\.com\.sa\/employment-requests/.test(page.url())
  for (let i = 0; i < 40 && !onList(); i++) await sleep(500)
  return onList()
}

/** Search one passport on the list page. Returns the cards' text (0 cards = not chosen). */
async function search(page, passport) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  if (!(await signedIn(page))) return { signedOut: true }
  await sleep(1500)
  // "Passport Number" filter (an <app-filter-search>): its header button
  // opens it; its own input takes the passport; Enter applies it.
  await page.waitForFunction(() => [...document.querySelectorAll('app-filter-search')].some(f => /Passport Number/i.test(f.textContent || '')), { timeout: 30000 }).catch(() => {})
  const filter = await page.evaluateHandle(() =>
    [...document.querySelectorAll('app-filter-search')].find(f => /Passport Number/i.test(f.textContent || '')))
  if (!filter.asElement()) throw new Error('Musaned: the "Passport Number" filter was not found')
  await filter.asElement().evaluate(f => f.querySelector('button.app-filter-header, .app-filter-header')?.click())
  await sleep(700)
  const input = await filter.asElement().$('input')
  if (!input) throw new Error('Musaned: the passport search box did not open')
  await input.evaluate(i => { i.focus(); i.value = '' })
  await input.type(passport, { delay: 40 })
  await input.press('Enter')
  // Wait for the list to follow the filter (the chip with the passport shows).
  await page.waitForFunction((p) => (document.body.innerText || '').includes(`Passport Number:`) && (document.body.innerText || '').includes(p), { timeout: 20000 }, passport).catch(() => {})
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {})
  await sleep(1000)
  const cards = await page.evaluate(() => {
    const out = []
    for (const b of document.querySelectorAll('button, a')) {
      if (!/^\s*DETAILS\s*$/i.test(b.innerText || '')) continue
      let card = b
      for (let i = 0; i < 8 && card && !/CONTRACT NUMBER/i.test(card.innerText || ''); i++) card = card.parentElement
      if (card) out.push(card.innerText.replace(/\s+\n/g, '\n').trim())
    }
    return out
  })
  return { cards }
}

/** The card: "SENT TO SAUDI EMBASSY … 2005575571 1908448891 … Paid 2026-09-21 11:40". */
export function parseCard(text) {
  const t = String(text || '')
  const stage = (t.split('\n')[0] || '').trim()
  const nums = t.match(/\b\d{10}\b/g) || []
  const pay = t.match(/\b(Unpaid|Paid)\b/i)?.[1]
  const date = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1]
  return { stage: /CONTRACT NUMBER/i.test(stage) ? '' : stage.toUpperCase(), contract_number: nums[0] || '', visa_number: nums[1] || '', payment: pay ? pay[0].toUpperCase() + pay.slice(1).toLowerCase() : '', created: date || '' }
}

/** Label → value pairs from the contract page (labels like "VISA NUMBER:" / "City of Work:"). */
function readDetails() {
  const pairs = {}
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const els = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /:\s*$/.test(e.textContent || '') && (e.textContent || '').length < 60)
  for (const el of els) {
    const label = clean(el.textContent).replace(/:$/, '')
    // The value is the next element with text (same parent first, then the parent's next sibling).
    let v = ''
    let n = el.nextElementSibling
    while (n && !v) { v = clean(n.innerText); n = n.nextElementSibling }
    if (!v) { let p = el.parentElement?.nextElementSibling; while (p && !v) { v = clean(p.innerText); p = p.nextElementSibling } }
    if (label && v && v.length < 300 && !(label in pairs)) pairs[label] = v
  }
  const body = document.body.innerText || ''
  const stages = [...document.querySelectorAll('*')].filter(e => e.children.length <= 1 && /^\s*✓/.test(e.textContent || '') && (e.textContent || '').length < 40).map(e => clean(e.textContent).replace(/^✓\s*/, ''))
  const tawassut = body.match(/Tawassut Contract Number\s*(\d+)/i)?.[1] || ''
  const contract = body.match(/Contract\s*#\s*(\d+)/i)?.[1] || ''
  // Party boxes: "EMPLOYER INFO" heading then the name.
  const employerName = (() => {
    const h = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^\s*EMPLOYER INFO\s*$/i.test(e.textContent || ''))
    let n = h?.parentElement?.nextElementSibling || h?.nextElementSibling
    return n ? clean(n.innerText).split('\n')[0].slice(0, 120) : ''
  })()
  const pdfs = [...document.querySelectorAll('a, span, button')].filter(a => /\.pdf\s*$/i.test(a.textContent || '')).map(a => {
    // The label above the link: "Generated contract template:" …
    let lab = ''
    let p = a
    for (let i = 0; i < 4 && p && !lab; i++) {
      let s = p.previousElementSibling
      while (s && !lab) { if (/:\s*$/.test(s.textContent || '')) lab = clean(s.textContent); s = s.previousElementSibling }
      p = p.parentElement
    }
    return { name: clean(a.textContent), label: lab }
  })
  return { pairs, stages, tawassut, contract, employerName, pdfs }
}

function pick(pairs, ...labels) {
  for (const l of labels) {
    const k = Object.keys(pairs).find(x => x.toLowerCase() === l.toLowerCase())
    if (k) return pairs[k]
  }
  return ''
}

/**
 * Click a PDF link: Musaned opens file-viewer.html in a new tab with the PDF
 * as a blob in an iframe. Read the blob inside that tab, then close it.
 */
async function downloadPdf(browser, page, name) {
  const newTab = new Promise(resolve => {
    const on = async (t) => { if (t.opener() === page.target() || /file-viewer/.test(t.url())) { browser.off('targetcreated', on); resolve(t) } }
    browser.on('targetcreated', on)
    setTimeout(() => { browser.off('targetcreated', on); resolve(null) }, 30000)
  })
  const clicked = await page.evaluate((name) => {
    const a = [...document.querySelectorAll('a, span, button')].find(x => (x.textContent || '').trim() === name)
    if (!a) return false
    a.scrollIntoView({ block: 'center' }); a.click(); return true
  }, name)
  if (!clicked) throw new Error(`link ${name} not found`)
  const target = await newTab
  if (!target) throw new Error(`${name}: no viewer tab opened`)
  const viewer = await target.page()
  try {
    await viewer.waitForFunction(() => /^blob:/.test(document.querySelector('iframe')?.src || ''), { timeout: 45000, polling: 300 })
    const b64 = await viewer.evaluate(async () => {
      const r = await fetch(document.querySelector('iframe').src)
      const buf = new Uint8Array(await r.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    })
    const buf = Buffer.from(b64, 'base64')
    if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error(`${name}: not a PDF`)
    return buf
  } finally {
    await viewer.close().catch(() => {})
  }
}

/** Store a PDF in a profile field unless the same bytes are there already. */
async function savePdf(db, profileId, fieldName, buf, original) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  let field = await db('profile_fields').where({ profile_id: profileId, name: fieldName }).first()
  const now = new Date().toISOString()
  if (!field) {
    const tpl = await db('field_templates').where('name', fieldName).first().catch(() => null)
    const [id] = await db('profile_fields').insert({ profile_id: profileId, field_template_id: tpl?.id || null, name: fieldName, data_type: 'file', is_permanent: 1, created_at: now, updated_at: now })
    field = { id }
  }
  const same = await db('files').where({ profile_field_id: field.id, content_hash: hash }).first()
  if (same) return false
  fs.mkdirSync(SAFE, { recursive: true })
  const stored = `${Date.now()}_${String(original || 'contract.pdf').replace(/[^\w.\-]+/g, '_')}`
  fs.writeFileSync(path.join(SAFE, stored), buf)
  await db('files').insert({ profile_field_id: field.id, original_name: original, path: stored, mimetype: 'application/pdf', size: buf.length, content_hash: hash, created_at: now, updated_at: now })
  return true
}

async function task(db, profileId, title, description) {
  try {
    const open = await db('tasks').where({ title, status: 'pending' }).first()
    if (open) return
    await db('tasks').insert({ type: 'automation', title, description, status: 'pending', profile_id: profileId, assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString() })
  } catch {}
}

/** Look one profile up in the open tab and save what Musaned shows. */
async function checkOne(db, browser, page, p) {
  const passport = String(p.passport_number).trim().toUpperCase()
  const s = await search(page, passport)
  if (s.signedOut) return { state: 'signed-out' }
  if (!s.cards.length) {
    await db('profiles').where('id', p.id).update({ contract_checked_at: new Date().toISOString() })
    return { state: 'not-chosen' }
  }
  const card = parseCard(s.cards[0])

  // DETAILS → the contract page.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
    page.evaluate(() => [...document.querySelectorAll('button, a')].find(b => /^\s*DETAILS\s*$/i.test(b.innerText || ''))?.click()),
  ])
  await page.waitForFunction(() => /Contract\s*#\s*\d+/i.test(document.body.innerText || ''), { timeout: 30000 }).catch(() => {})
  // "Expand" opens the hidden candidate/employer details.
  await page.evaluate(() => [...document.querySelectorAll('button, a, span, div')].filter(e => /^\s*Expand\s*$/i.test(e.textContent || '') && e.children.length <= 2).forEach(e => e.click())).catch(() => {})
  await sleep(1200)
  const d = await page.evaluate(readDetails)

  const now = new Date().toISOString()
  const first = !p.chosen_at
  const update = {
    musaned_stage: card.stage || d.stages[d.stages.length - 1] || p.musaned_stage,
    musaned_payment: card.payment || pick(d.pairs, 'Payment'),
    musaned_pro: pick(d.pairs, 'PRO', 'Recruitment Office') || p.musaned_pro,
    contract_number: d.contract || card.contract_number,
    visa_number: pick(d.pairs, 'VISA NUMBER', 'Visa Number') || card.visa_number,
    tawassut_number: d.tawassut || p.tawassut_number,
    employer_name: d.employerName || p.employer_name,
    employer_id: pick(d.pairs, 'National ID', 'National ID Number', 'Employer ID', 'ID Number') || p.employer_id,
    employer_phone: pick(d.pairs, 'MOBILE NUMBER', 'Mobile Number', 'Phone') || p.employer_phone,
    employer_address: pick(d.pairs, 'LOCATION', 'Location', 'Address') || p.employer_address,
    work_city: pick(d.pairs, 'City of Work') || p.work_city,
    salary: pick(d.pairs, 'Salary') || p.salary,
    issuing_authority: pick(d.pairs, 'Issuing Authority') || p.issuing_authority,
    job_title: pick(d.pairs, 'Job', 'Occupation', 'Profession') || p.job_title,
    contract_date: card.created || p.contract_date,
    contract_data: JSON.stringify({ ...JSON.parse(p.contract_data || '{}'), ...d.pairs, stages: d.stages, card: s.cards[0] }),
    contract_checked_at: now,
    ...(first ? { chosen_at: now } : {}),
  }
  for (const k of Object.keys(update)) if (update[k] === '' || update[k] === undefined) delete update[k]
  await db('profiles').where('id', p.id).update(update)

  // The PDFs at the bottom.
  const saved = []
  for (const pdf of d.pdfs) {
    const fieldName = (PDF_FIELDS.find(([re]) => re.test(pdf.label) || re.test(pdf.name)) || [null, 'Contract'])[1]
    try {
      const buf = await downloadPdf(browser, page, pdf.name)
      if (await savePdf(db, p.id, fieldName, buf, pdf.name)) saved.push(pdf.name)
    } catch (e) { console.warn(`[contracts] ${p.full_name}: ${e.message}`) }
  }

  if (first) {
    await task(db, p.id, `Chosen on Musaned: ${p.full_name}`, `Contract ${update.contract_number || ''} · ${update.employer_name || ''} · ${update.musaned_stage || ''}. Wafid medical booking started.`)
    try { const { queueWafidBooking } = await import('./wafidStatus.js'); await queueWafidBooking(db, p.id, 'chosen') } catch (e) { console.warn('[contracts] wafid:', e.message) }
  } else if (p.musaned_stage && update.musaned_stage && p.musaned_stage !== update.musaned_stage) {
    await task(db, p.id, `Musaned: ${p.full_name} → ${update.musaned_stage}`, `Was ${p.musaned_stage}.`)
  }
  return { state: 'chosen', stage: update.musaned_stage, contract: update.contract_number, pdfs: saved, first }
}

/** Check every profile (or one). */
export async function checkContracts(db, { onlyId = null } = {}) {
  if (contractCheck.running) return { busy: true }
  Object.assign(contractCheck, { running: true, results: [], signedOut: false })
  let page = null
  try {
    const list = await candidates(db, onlyId)
    if (!list.length) return { checked: 0 }
    const browser = await getBrowser()
    page = await browser.newPage()
    await setupTab(page, { runId: 'musaned-contracts' })
    page.__adalAllowImages = true
    for (const [i, p] of list.entries()) {
      if (i) await sleep(BETWEEN_MS)
      let r
      try { r = await checkOne(db, browser, page, p) } catch (e) { r = { state: 'error', error: e.message } }
      contractCheck.results.push({ id: p.id, name: p.full_name, passport: p.passport_number, ...r })
      console.log(`[contracts] ${p.full_name} (${p.passport_number}): ${r.state}${r.stage ? ' · ' + r.stage : ''}${r.error ? ' — ' + r.error : ''}`)
      if (r.state === 'signed-out') {
        contractCheck.signedOut = true
        await task(db, null, 'Sign in to Musaned for the contract check',
          'Adal Keep looks every 4 hours whether a Saudi employer chose a girl, but Musaned is signed out. Open Musaned in the Adal Keep Brave and sign in (captcha + OTP), then press "Check contracts now" in Settings.')
        break
      }
    }
    return { checked: contractCheck.results.length, results: contractCheck.results }
  } finally {
    try { await page?.close() } catch {}
    contractCheck.running = false
    contractCheck.last = new Date().toISOString()
  }
}

let timer = null
export function startContractChecker(db) {
  if (timer) return
  const tick = () => checkContracts(db).catch(e => console.warn('[contracts] failed:', e.message))
  setTimeout(tick, 6 * 60 * 1000)
  timer = setInterval(tick, EVERY_MS)
  console.log(`📄 Musaned contracts checked every ${EVERY_MS / 3600000} h`)
}
