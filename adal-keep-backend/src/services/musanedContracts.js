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
 * Musaned needs a signed-in Musaned in Adal Browser (captcha + OTP are
 * always a person's). Signed out → one reminder task, and the check waits.
 * Nothing on Musaned is ever changed: it only searches, reads and downloads.
 */
import fs from 'fs'
import sharp from 'sharp'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getBrowser, openBrowserIfAny } from './browser.js'
import { setupTab, borrowTab, borrowOpenTab, doneWithTab, activeRunIds } from './tabManager.js'

const SAFE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
const LIST_URL = 'https://tawtheeq.musaned.com.sa/employment-requests?sort=createdAt,DESC&page=0&size=10'
// A request the employer made that waits for our (EPRO) approval.
const PENDING_URL = 'https://tawtheeq.musaned.com.sa/employment-requests/pending'
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
  const onMusaned = db('automation_queue').where('workflow_id', 'musaned_add_candidate').where('status', 'done').select('profile_id')
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
async function search(page, passport, url = LIST_URL) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
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
  const input = await filter.asElement().$('textarea, input') // Musaned uses a <textarea>
  if (!input) throw new Error('Musaned: the passport search box did not open')
  await input.evaluate(i => { i.focus(); i.value = '' })
  await input.type(passport, { delay: 40 })
  await input.press('Enter')
  // Wait for the list to follow the filter (the chip with the passport shows).
  await page.waitForFunction((p) => (document.body.innerText || '').includes(`Passport Number:`) && (document.body.innerText || '').includes(p), { timeout: 20000 }, passport).catch(() => {})
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {})
  await sleep(1000)
  return { cards: await readCards(page) }
}

/** Every request card on the page (its text, as parseCard reads it). */
function readCards(page) {
  return page.evaluate(() => {
    const out = []
    for (const b of document.querySelectorAll('button, a')) {
      if (!/^\s*DETAILS\s*$/i.test(b.innerText || '')) continue
      let card = b
      for (let i = 0; i < 8 && card && !/CONTRACT NUMBER/i.test(card.innerText || ''); i++) card = card.parentElement
      if (card) out.push(card.innerText.replace(/\s+\n/g, '\n').trim())
    }
    return out
  })
}

const nameWords = (s) => String(s || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1)
/** Profiles whose name shares 2+ words with the card's (a new profile is made only when none does). */
export function nameLookalikes(card, profiles) {
  const c = nameWords(card.candidate)
  if (c.length < 2) return []
  return profiles.filter(p => { const w = nameWords(p.full_name); return c.filter(x => w.includes(x)).length >= Math.min(2, c.length) })
}

/** The profile a Musaned card is about: its contract number, else her name. */
export function matchCard(card, profiles) {
  if (card.contract_number) {
    const byContract = profiles.find(p => String(p.contract_number || '') === card.contract_number)
    if (byContract) return byContract
  }
  if (card.passport) {
    const byPassport = profiles.find(p => String(p.passport_number || '').toUpperCase().replace(/\s+/g, '') === card.passport)
    if (byPassport) return byPassport
  }
  const c = nameWords(card.candidate)
  if (c.length < 2) return null
  let best = null, bestScore = 0
  for (const p of profiles) {
    const w = nameWords(p.full_name)
    if (w.length < 2) continue
    const same = c.filter(x => w.includes(x)).length
    const need = Math.min(3, c.length, w.length)
    // Musaned puts the names in another order (KEMAL TESHULA AHMED = TESHULA
    // AHMED KEMAL): at least 3 of the words, in any order (all of a shorter name).
    if (same < need) continue
    const score = same * 10 - Math.abs(w.length - c.length)
    if (score > bestScore) { best = p; bestScore = score } else if (score === bestScore) best = null   // two girls alike: not sure
  }
  return best
}

/**
 * The whole Employment Requests list (and Pending), newest first, instead of
 * searching every passport: a card that is new to Adal Keep — a girl newly
 * chosen — or whose stage moved is opened (checkOne: contract, PDFs, task,
 * Wafid booking). Stops paging once a whole page is already known.
 */
// Worth opening: she is newly chosen, or her request moved on.
const cardIsNew = (p, c) => (!p.chosen_at && !/CANCEL|REJECT/i.test(c.stage || '')) ||
  (c.stage && (p.musaned_stage || '') !== c.stage) || (c.contract_number && p.contract_number !== c.contract_number)

export async function scanContracts(db, { auto = false } = {}) {
  if (contractCheck.running) return { busy: true }
  // The check every 4 hours never opens Brave itself: it waits until Brave is
  // open (a person closed it, or quit Adal Keep — it must not come back).
  if (auto && !(await openBrowserIfAny())) { console.log('[contracts] Brave is closed — checking when it is open'); return { skipped: true } }
  // By itself: only in a Musaned tab already open, signed in and free — never a new tab.
  let page = null, backTo = ''
  if (auto) {
    const browser = await openBrowserIfAny()
    page = browser ? await borrowOpenTab(browser, 'musaned_check_chosen', await activeRunIds(db)) : null
    if (!page) return { skipped: true, why: 'no free Musaned tab open' }
    if (/\/(login|auth)\b|sso\.|wahid\.sa|\/realms\//i.test(page.url())) { await doneWithTab(page).catch(() => {}); return { skipped: true, why: 'Musaned is signed out' } }
    backTo = page.url()
  }
  Object.assign(contractCheck, { running: true, results: [], signedOut: false, mode: 'list', unknown: [], auto })
  try {
    const profiles = await db('profiles').select('*')
    const browser = await getBrowser()
    if (!page) page = await borrowTab(browser, 'musaned_check_chosen', await activeRunIds(db))
    await setupTab(page, { runId: 'musaned-contracts' })
    page.__adalAllowImages = true
    // Musaned's own list data first (no passport searched, every detail at once).
    const viaApi = await scanListByApi(db, page, { log: (m) => console.log('[contracts] ' + m) }).catch(e => ({ ok: false, why: e.message }))
    if (viaApi.ok) {
      contractCheck.results = viaApi.results
      contractCheck.added = viaApi.added
      await doneSignInTasks(db)
      import('./profileDays.js').then(d => d.snapshotDays(db)).catch(() => {})
      console.log('[contracts] Musaned list: ' + viaApi.checked + ' requests read, ' + viaApi.added.length + ' added, ' + viaApi.results.filter(r => !r.unchanged).length + ' updated')
      return { checked: viaApi.checked, newlyChosen: viaApi.results.filter(r => r.first).map(r => r.name), results: viaApi.results, unknown: [], added: viaApi.added }
    }
    console.warn('[contracts] Musaned list data not read (' + viaApi.why + ') — reading its pages instead')
    const open = async (url) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
      return signedIn(page)
    }
    let ok = await open(LIST_URL.replace('size=10', 'size=50'))
    if (!ok && !auto && await signInForCheck(db, page)) ok = await open(LIST_URL.replace('size=10', 'size=50'))
    if (!ok && auto) return { signedOut: true }
    if (!ok) {
      contractCheck.signedOut = true
      await task(db, null, SIGN_IN_TASKS[1], 'Adal Keep looks at the Musaned list for newly chosen girls, but Musaned is signed out. Sign in to Musaned in Adal Browser whenever you can (captcha + code) — Adal Keep notices it by itself and checks again.')
      return { signedOut: true }
    }
    const cards = []
    for (let n = 0; n < 10; n++) {
      if (n) await open(LIST_URL.replace('size=10', 'size=50').replace('page=0', `page=${n}`))
      await page.waitForFunction(() => /CONTRACT NUMBER|No (data|records|results)/i.test(document.body.innerText || ''), { timeout: 20000 }).catch(() => {})
      await sleep(1200)
      const url = page.url()
      const here = (await readCards(page)).map(t => ({ ...parseCard(t), text: t, url }))
      if (!here.length) break
      cards.push(...here)
      const allKnown = here.every(c => { const p = matchCard(c, profiles); return p && !cardIsNew(p, c) })
      if (allKnown || here.length < 50) break
    }
    // Requests that wait for our approval (one page).
    try {
      if (await open(PENDING_URL)) {
        await sleep(1500)
        for (const t of await readCards(page)) { const c = parseCard(t); cards.push({ ...c, stage: c.stage || 'EPRO APPROVAL', text: t, pending: true, url: PENDING_URL }) }
      }
    } catch (e) { console.warn('[contracts] pending list:', e.message) }
    console.log(`[contracts] Musaned list: ${cards.length} requests`)

    const seen = new Set()
    for (const c of cards) {
      const p = matchCard(c, profiles)
      if (!p) { contractCheck.unknown.push({ candidate: c.candidate || c.passport, contract: c.contract_number, stage: c.stage, card: c }); continue }
      if (seen.has(p.id)) continue
      seen.add(p.id)
      if (!cardIsNew(p, c)) { contractCheck.results.push({ id: p.id, name: p.full_name, state: 'chosen', stage: c.stage, unchanged: true }); continue }
      if (!p.passport_number) { contractCheck.results.push({ id: p.id, name: p.full_name, state: 'error', error: 'no passport number on the profile' }); continue }
      await sleep(BETWEEN_MS / 2)
      let r
      try { r = await checkOne(db, browser, page, p) } catch (e) { r = { state: 'error', error: e.message } }
      contractCheck.results.push({ id: p.id, name: p.full_name, passport: p.passport_number, ...r })
      console.log(`[contracts] ${p.full_name}: ${r.state}${r.first ? ' (NEW)' : ''}${r.stage ? ' · ' + r.stage : ''}${r.error ? ' — ' + r.error : ''}`)
    }
    // On Musaned but not in Adal Keep: her profile is made from Musaned's
    // contract page (names, passport, birth, …) with the contract and PDFs.
    contractCheck.added = []
    const done = new Set()
    for (const u of contractCheck.unknown) {
      const c = u.card
      delete u.card
      if (!c.contract_number || done.has(c.contract_number)) continue
      done.add(c.contract_number)
      const alike = nameLookalikes(c, profiles)
      if (alike.length) { u.note = `not added — looks like ${alike.slice(0, 2).map(p => p.full_name).join(' / ')}`; continue }
      try {
        await sleep(BETWEEN_MS / 2)
        await page.goto(c.url, { waitUntil: 'networkidle2', timeout: 60000 })
        if (!(await signedIn(page))) break
        await page.waitForFunction((n) => (document.body.innerText || '').includes(n), { timeout: 20000 }, c.contract_number).catch(() => {})
        const d = await openDetails(page, c.contract_number)
        const r = await addFromMusaned(db, browser, page, c, d)
        u.note = r.existing ? `matched by passport: ${r.name}` : `added as a new profile`
        if (!r.existing) contractCheck.added.push({ id: r.id, name: r.name, stage: c.stage })
        contractCheck.results.push({ id: r.id, name: r.name, ...r.result })
        console.log(`[contracts] ${c.candidate}: ${u.note}`)
      } catch (e) { u.note = `not added — ${e.message}`; console.warn(`[contracts] ${c.candidate}: ${e.message}`) }
    }
    await doneSignInTasks(db)
    const fresh = contractCheck.results.filter(r => r.first)
    import('./profileDays.js').then(d => d.snapshotDays(db)).catch(() => {})
    return { checked: cards.length, newlyChosen: fresh.map(r => r.name), results: contractCheck.results, unknown: contractCheck.unknown }
  } finally {
    // The tab goes back to the page it was on (the person's place there).
    if (backTo && page && !page.isClosed?.()) await page.goto(backTo, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await doneWithTab(page).catch(() => {})
    contractCheck.running = false
    contractCheck.last = new Date().toISOString()
  }
}

/** The card: "SENT TO SAUDI EMBASSY … 2005575571 1908448891 … Paid 2026-09-21 11:40". */
export function parseCard(text) {
  const t = String(text || '')
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean)
  const after = (label) => { const i = lines.findIndex(x => x.toUpperCase() === label); return i >= 0 ? (lines[i + 1] || '') : '' }
  const stage = lines[0] || ''
  const employer = after('EMPLOYER')            // "1111702179 - ABDULLAH ALIHMADI"
  const pay = after('PAYMENT')
  return {
    stage: /CONTRACT NUMBER/i.test(stage) ? '' : stage.toUpperCase(),
    contract_number: after('CONTRACT NUMBER'),
    visa_number: after('VISA NUMBER'),
    employer_id: employer.match(/^(\d{6,})\s*-/)?.[1] || '',
    employer_name: employer.replace(/^\d{6,}\s*-\s*/, ''),
    candidate: after('CANDIDATE').toUpperCase(),
    passport: after('PASSPORT NUMBER').toUpperCase().replace(/\s+/g, ''),   // the Pending list shows this instead of her name
    job: after('JOB'),
    pro: after('PRO'),
    payment: /^unpaid$/i.test(pay) ? 'Unpaid' : /^paid$/i.test(pay) ? 'Paid' : pay,
    created: after('CREATION DATE').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
  }
}

/**
 * Label → value pairs from the contract page. Musaned shows each detail as a
 * label element (.form-label / .app-info-partial-label) followed by its value.
 * The employer box comes first; a label seen again (Mobile Number, Visa
 * Number in the candidate box) is kept as "Candidate · <label>".
 */
function readDetails() {
  const pairs = {}
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  for (const el of document.querySelectorAll('.form-label, .app-info-partial-label')) {
    const label = clean(el.textContent).replace(/:$/, '')
    const v = clean(el.nextElementSibling?.innerText)
    if (!label || !v || v.length > 300) continue
    if (/\.pdf$/i.test(v) || /^Attachments$/i.test(label)) continue
    pairs[label in pairs ? `Candidate · ${label}` : label] = v
  }
  const body = document.body.innerText || ''
  const stages = [...document.querySelectorAll('.app-status-wizard-item.done')].map(e => clean(e.textContent))
  const tawassut = body.match(/Tawassut Contract Number\s*(\d+)/i)?.[1] || ''
  const contract = body.match(/Contract\s*#\s*(\d+)/i)?.[1] || ''
  const employerName = (() => {
    const h = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^\s*EMPLOYER INFO\s*$/i.test(e.textContent || ''))
    let box = h?.parentElement
    for (let i = 0; i < 3 && box && clean(box.innerText).replace(/EMPLOYER INFO/i, '').trim().length < 3; i++) box = box.parentElement
    const lines = String(box?.innerText || '').split('\n').map(clean).filter(x => x && !/^EMPLOYER INFO$/i.test(x))
    return (lines[0] || '').slice(0, 120)
  })()
  const pdfs = [...document.querySelectorAll('a, span, button')].filter(a => a.children.length === 0 && /\.pdf\s*$/i.test(a.textContent || '')).map(a => {
    // The label above the link: "Generated contract template", "PRO and EMPLOYER signed contract" …
    let lab = '', p = a
    for (let i = 0; i < 5 && p && !lab; i++) {
      let sib = p.previousElementSibling
      while (sib && !lab) { const t = clean(sib.innerText); if (t && !/\.pdf$/i.test(t)) lab = t; sib = sib.previousElementSibling }
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

/**
 * Reads a contract that is a scan / photo (no text inside): each of its first
 * pages is rendered, JEV points to the English column, Tesseract reads it
 * (JEV off → the left half of the page). Returns the text.
 */
async function readContractScan(buf) {
  const mupdf = await import('mupdf')
  const { createWorker } = await import('tesseract.js')
  const { findOnPage } = await import('./jevClassifier.js')
  const doc = mupdf.Document.openDocument(buf, 'application/pdf')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const worker = await createWorker(['eng'], 1, { langPath: root, cachePath: path.join(root, 'data', 'tessdata'), gzip: false })
  let text = ''
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '4' })
    // The parties are on the first two pages.
    for (let i = 0; i < Math.min(2, doc.countPages()); i++) {
      const png = Buffer.from(doc.loadPage(i).toPixmap([3, 0, 0, 3, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true).asPNG())
      const meta = await sharp(png).metadata()
      const b = (await findOnPage(png, { english: 'The whole English-language column of this bilingual contract page (all the English text, not the Arabic).' }))?.english
      const use = b && b.confidence >= 0.2 && b.right - b.left > 0.25 ? b : { left: 0, right: 0.52, top: 0, bottom: 1 }
      const L = Math.max(0, Math.floor((use.left - 0.02) * meta.width)), R = Math.min(meta.width, Math.ceil((use.right + 0.02) * meta.width))
      const T = Math.max(0, Math.floor((use.top - 0.02) * meta.height)), B = Math.min(meta.height, Math.ceil((use.bottom + 0.02) * meta.height))
      const col = await sharp(png).extract({ left: L, top: T, width: R - L, height: B - T }).grayscale().normalise().png().toBuffer()
      text += (await worker.recognize(col)).data.text + '\n'
    }
  } finally { await worker.terminate().catch(() => {}) }
  return text
}

/** The text of a PDF (pdf-parse). */
async function pdfText(buf) {
  const m = await import('pdf-parse')
  if (m.PDFParse) { const p = new m.PDFParse({ data: buf }); try { return (await p.getText()).text } finally { await p.destroy?.() } }
  return (await (m.default || m)(buf)).text
}

/**
 * Musaned's standard contract (template.pdf), English side: the parties,
 * each "Label: value", the values before the Arabic half of the line.
 */
export function parseTemplateText(text) {
  const lines = String(text || '').split('\n').map(l => l.split('\t')[0].trim())
  const arabic = /[\u0600-\u06FF\uFB50-\uFEFF]/
  const sections = { employer: [], saudiAgency: [], worker: [], ourAgency: [] }
  let at = null
  for (const l of lines) {
    if (/^A\.\s*Employer:/i.test(l)) { at = 'employer'; continue }
    if (/Saudi Recruiting Agency:/i.test(l)) { at = 'saudiAgency'; continue }
    if (/^B\.\s*Domestic Service Worker:/i.test(l)) { at = 'worker'; continue }
    if (/country by Recruitment Agency:|^Recruitment Agency:/i.test(l)) { at = 'ourAgency'; continue }
    if (/^The employer and the DSW|^1\.\s*Preamble/i.test(l)) { at = null; continue }
    if (at) sections[at].push(l)
  }
  const field = (sec, label) => {
    const ls = sections[sec]
    const i = ls.findIndex(l => new RegExp(`^${label}\\s*:`, 'i').test(l))
    if (i < 0) return ''
    let v = ls[i].replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').replace(arabic.test(ls[i]) ? /\s*[^\x00-\x7F].*$/ : /$^/, '').trim()
    // A name that goes on to the next line ("Essam … Alahmadi" / "Recruitment Office").
    for (let j = i + 1; j < ls.length && /^[A-Za-z][A-Za-z .&'-]*$/.test(ls[j]) && !/:/.test(ls[j]) && !/^(Address|Contact Numbers|Hereinafter)/i.test(ls[j]); j++) v += ` ${ls[j]}`
    return v.trim()
  }
  const date = String(text).match(/corresponding to \((\d{2})\/(\d{2})\/(\d{4})\)/i)
  return {
    contractNumber: (String(text).match(/CONTRACT\s*#\s*(\d+)/i) || [])[1] || '',
    visaNumber: (String(text).match(/VISA NUMBER\s*#\s*(\d+)/i) || [])[1] || '',
    contractDate: date ? `${date[3]}-${date[2]}-${date[1]}` : '',
    employer: { name: field('employer', 'Name'), id: field('employer', 'National ID Number'), city: field('employer', 'City'), mobile: field('employer', 'Mobile'), telephone: field('employer', 'Telephone') },
    saudiAgency: { name: field('saudiAgency', 'Name'), license: field('saudiAgency', 'License no'), phone: field('saudiAgency', 'Telephone'), city: field('saudiAgency', 'City'), email: field('saudiAgency', 'Email') },
    worker: { name: field('worker', 'Name'), position: field('worker', 'Position'), nextOfKin: field('worker', 'Next of kin'), relationship: field('worker', 'Relationship') },
    ourAgency: { name: field('ourAgency', 'Name'), license: field('ourAgency', 'License No') },
  }
}

/** Writes what template.pdf says into the profile (keeps what is there). */
export async function applyTemplate(db, profileId, buf) {
  let text = await pdfText(buf).catch(() => '')
  let t = parseTemplateText(text)
  // A scan or photo has no text inside: JEV finds the English half of each
  // page, the local OCR reads it, and the same code sorts it out.
  if (!t.employer.name) {
    const scanned = await readContractScan(buf).catch(e => { console.warn('[contracts] scan read failed:', e.message); return '' })
    const ts = parseTemplateText(scanned)
    if (ts.employer.name || ts.contractNumber) { text = scanned; t = ts }
  }
  if (!t.contractNumber && !t.employer.name) return null
  // Hers? The contract prints her passport number.
  const own = await db('profiles').where('id', profileId).first('passport_number', 'full_name')
  const pp = String(own?.passport_number || '').trim().toUpperCase()
  const printed = (String(text).match(/Passport No:\s*([A-Z]{1,3}\d{6,9})/i) || [])[1]?.toUpperCase()
  if (pp && printed && printed !== pp) {
    console.warn(`[contracts] ${own.full_name}: template.pdf is for passport ${printed}, not ${pp} — not used`)
    return null
  }
  const now = await db('profiles').where('id', profileId).first('contract_data', 'employer_name', 'musaned_pro', 'employer_phone', 'employer_id', 'contract_date', 'contract_number', 'visa_number', 'chosen_at')
  let data = {}
  try { data = JSON.parse(now.contract_data || '{}') || {} } catch {}
  const upd = { contract_data: JSON.stringify({ ...data, ...templateFields(t).data }) }
  // The contract's full name (LMIS asks the employer's full name).
  if (t.employer.name && t.employer.name.length > String(now.employer_name || '').length) upd.employer_name = t.employer.name
  if (!now.musaned_pro && t.saudiAgency.name) upd.musaned_pro = t.saudiAgency.name
  if (!now.employer_phone && t.employer.mobile) upd.employer_phone = t.employer.mobile
  if (!now.employer_id && t.employer.id) upd.employer_id = t.employer.id
  if (!now.contract_date && t.contractDate) upd.contract_date = t.contractDate
  if (!now.contract_number && t.contractNumber) upd.contract_number = t.contractNumber
  if (!now.visa_number && t.visaNumber) upd.visa_number = t.visaNumber
  if (!now.chosen_at) upd.chosen_at = new Date().toISOString() // a contract means an employer chose her
  await db('profiles').where('id', profileId).update(upd)
  if (!now.chosen_at) import('./whatsapp.js').then(w => w.onChosen(db, profileId)).catch(e => console.warn('[contracts] whatsapp:', e.message))
  return t
}

/**
 * Once at start: profiles whose template.pdf was saved before Adal Keep read
 * it get its details now (no Musaned needed).
 */
export async function readSavedTemplates(db) {
  const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.name', 'Contract').where('files.original_name', 'like', '%template%')
    .select('profile_fields.profile_id', 'files.path').orderBy('files.id', 'desc').catch(() => [])
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.profile_id)) continue
    seen.add(r.profile_id)
    const p = await db('profiles').where('id', r.profile_id).first('contract_data', 'full_name')
    if (!p || /Employer Full Name/.test(p.contract_data || '')) continue
    const file = path.join(SAFE, path.basename(r.path))
    if (!fs.existsSync(file)) continue
    try { if (await applyTemplate(db, r.profile_id, fs.readFileSync(file))) console.log(`[contracts] ${p.full_name}: details read from template.pdf`) }
    catch (e) { console.warn(`[contracts] ${p.full_name}: template.pdf not read — ${e.message}`) }
  }
}

/** The contract's details as profile contract_data labels. */
function templateFields(t) {
  const data = {
    'Employer Full Name': t.employer.name, 'Employer City': t.employer.city, 'Employer Telephone': t.employer.telephone,
    'Saudi Agency': t.saudiAgency.name, 'Saudi Agency License': t.saudiAgency.license, 'Saudi Agency Phone': t.saudiAgency.phone,
    'Saudi Agency City': t.saudiAgency.city, 'Saudi Agency Email': t.saudiAgency.email,
    'Our Agency': t.ourAgency.name, 'Our Agency License': t.ourAgency.license, 'Contract Date': t.contractDate,
  }
  for (const k of Object.keys(data)) if (!data[k]) delete data[k]
  return { data }
}

/** Store a PDF in a profile field unless the same bytes are there already. */
export async function savePdf(db, profileId, fieldName, buf, original) {
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
  // A newer copy of the same document (Wafid makes its PDFs anew each time):
  // it takes the old copy's place instead of piling up.
  const older = original ? await db('files').where({ profile_field_id: field.id, original_name: original }).orderBy('id', 'desc').first() : null
  if (older) {
    await db('files').where({ id: older.id }).update({ path: stored, size: buf.length, content_hash: hash, updated_at: now })
    try { if (older.path && !older.path.includes('/') && older.path !== stored) fs.unlinkSync(path.join(SAFE, older.path)) } catch {}
    return true
  }
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
  let s = await search(page, passport)
  if (s.signedOut) return { state: 'signed-out' }
  // Not in Employment Requests: an employer's request may still wait for our
  // approval under Pending Employment Requests — she is chosen all the same.
  let pending = false
  if (!s.cards.length) {
    const sp = await search(page, passport, PENDING_URL).catch(e => { console.warn('[contracts] pending:', e.message); return { cards: [] } })
    if (sp.cards?.length) { s = sp; pending = true }
  }
  if (!s.cards.length) {
    await db('profiles').where('id', p.id).update({ contract_checked_at: new Date().toISOString() })
    return { state: 'not-chosen' }
  }
  const card = parseCard(s.cards[0])
  if (pending && !card.stage) card.stage = 'EPRO APPROVAL'
  const d = await openDetails(page)
  return saveDetails(db, browser, page, p, card, s.cards[0], d)
}

/** DETAILS (of the card holding `contract`, else the first) → the contract page, read. */
async function openDetails(page, contract = '') {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
    page.evaluate((contract) => {
      const buttons = [...document.querySelectorAll('button, a')].filter(b => /^\s*DETAILS\s*$/i.test(b.innerText || ''))
      const inCard = (b) => { let c = b; for (let i = 0; i < 8 && c && !/CONTRACT NUMBER/i.test(c.innerText || ''); i++) c = c.parentElement; return c?.innerText || '' }
      ;(contract ? buttons.find(b => inCard(b).includes(contract)) : buttons[0])?.click()
    }, contract),
  ])
  await page.waitForFunction(() => /Contract\s*#\s*\d+/i.test(document.body.innerText || ''), { timeout: 30000 }).catch(() => {})
  // "Expand" opens the hidden candidate/employer details.
  await page.evaluate(() => [...document.querySelectorAll('button, a, span, div')].filter(e => /^\s*Expand\s*$/i.test(e.textContent || '') && e.children.length <= 2).forEach(e => e.click())).catch(() => {})
  await sleep(1200)
  return page.evaluate(readDetails)
}

/**
 * A girl on Musaned who is not in Adal Keep: her passport may still be here
 * (another name spelling) — else a new profile from the contract page.
 */
export async function addFromMusaned(db, browser, page, card, d) {
  const passport = String(pick(d.pairs, 'Passport Number') || '').trim().toUpperCase().replace(/\s+/g, '')
  let p = passport ? await db('profiles').whereRaw("upper(replace(passport_number, ' ', '')) = ?", [passport]).first() : null
  const existing = !!p
  if (!p) {
    const given = String(pick(d.pairs, 'Given Names') || '').trim().toUpperCase()
    const sur = String(pick(d.pairs, 'Surname') || '').trim().toUpperCase()
    const name = [given, sur].filter(Boolean).join(' ') || card.candidate
    const g = String(pick(d.pairs, 'Gender') || '').toUpperCase()
    const iso = (v) => (String(v || '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0]
    const now = new Date().toISOString()
    const company = await db('companies').first('id').catch(() => null)
    const row = {
      full_name: name, status: 'active', passport_number: passport || null, nationality: 'Ethiopian',
      first_name: given.split(' ')[0] || null, last_name: sur || null,
      date_of_birth: iso(pick(d.pairs, 'Date of Birth')), gender: g.startsWith('F') ? 'F' : g.startsWith('M') ? 'M' : null,
      marital_status: pick(d.pairs, 'Marital Status') || null, religion: pick(d.pairs, 'Religion') || null,
      passport_issue_date: iso(pick(d.pairs, 'Passport Issue Date')), passport_expiry_date: iso(pick(d.pairs, 'Passport Expiry Date')),
      place_of_birth: pick(d.pairs, 'Passport Issue Place') || null, education_level: pick(d.pairs, 'Education level') || null,
      phone_number: pick(d.pairs, 'Candidate · Mobile Number') || null, children_count: Number(pick(d.pairs, 'Number Of Children')) || 0,
      notes: `Added from the Musaned list (contract ${card.contract_number}) — not in Adal Keep before. Check her details and add her documents.`,
      company_id: company?.id || 1, created_by: 'Musaned list', created_at: now, updated_at: now,
    }
    for (const k of Object.keys(row)) if (row[k] === null || row[k] === '') delete row[k]
    const [id] = await db('profiles').insert(row)
    p = await db('profiles').where('id', id).first()
    await task(db, id, `On Musaned, added to Adal Keep: ${name}`, `She was on the Musaned list (${card.stage || 'request'}, contract ${card.contract_number}) but not in Adal Keep. Her profile was made from Musaned — check it and add her documents.`)
  }
  const result = await saveDetails(db, browser, page, p, card, card.text, d)
  return { id: p.id, name: p.full_name, existing, result }
}

/** What the contract page says goes into her profile, with its PDFs; tasks for news. */
async function saveDetails(db, browser, page, p, card, cardText, d) {

  const now = new Date().toISOString()
  // A cancelled or rejected request: the employer did not keep her — not chosen.
  const dead = /CANCEL|REJECT/i.test(card.stage || '')
  const first = !p.chosen_at && !dead
  const update = {
    musaned_stage: card.stage || (d.stages.length ? d.stages[d.stages.length - 1].toUpperCase() : p.musaned_stage),
    musaned_payment: card.payment || (d.stages.some(x => /^paid$/i.test(x)) ? 'Paid' : p.musaned_payment),
    musaned_pro: card.pro || p.musaned_pro,
    contract_number: d.contract || card.contract_number,
    visa_number: pick(d.pairs, 'Visa Number') || card.visa_number,
    tawassut_number: d.tawassut || p.tawassut_number,
    employer_name: d.employerName || card.employer_name || p.employer_name,
    employer_id: card.employer_id || p.employer_id,
    employer_phone: pick(d.pairs, 'Mobile Number') || p.employer_phone,
    employer_address: pick(d.pairs, 'Location') || p.employer_address,
    work_city: pick(d.pairs, 'City of Work') || p.work_city,
    salary: pick(d.pairs, 'Salary') || p.salary,
    issuing_authority: pick(d.pairs, 'Issuing Authority') || p.issuing_authority,
    job_title: card.job || pick(d.pairs, 'Job') || p.job_title,
    contract_date: card.created || p.contract_date,
    contract_data: JSON.stringify({ ...JSON.parse(p.contract_data || '{}'), ...d.pairs, stages: d.stages, card: cardText }),
    contract_checked_at: now,
    ...(first ? { chosen_at: now } : {}),
  }
  for (const k of Object.keys(update)) if (update[k] === '' || update[k] === undefined) delete update[k]
  await db('profiles').where('id', p.id).update(update)

  // The PDFs at the bottom.
  const saved = []
  let template = null
  let signed = null
  for (const pdf of d.pdfs) {
    // template.pdf is always the Contract; the signed ones go by Musaned's label.
    const fieldName = /template/i.test(pdf.name) ? 'Contract'
      : (PDF_FIELDS.find(([re]) => re.test(pdf.label) || re.test(pdf.name)) || [null, 'Contract'])[1]
    try {
      const buf = await downloadPdf(browser, page, pdf.name)
      if (fieldName === 'Contract') template = buf
      else if (!signed) signed = buf
      if (await savePdf(db, p.id, fieldName, buf, pdf.name)) saved.push(pdf.name)
    } catch (e) { console.warn(`[contracts] ${p.full_name}: ${e.message}`) }
  }

  // What the contract (template.pdf) itself says: the employer's full name,
  // city and phones, the Saudi recruitment agency, the contract date …
  // No template.pdf this time: a signed copy says the same (read as a scan if it is one).
  if (!template) template = signed
  if (template) {
    try { await applyTemplate(db, p.id, template) } catch (e) { console.warn(`[contracts] ${p.full_name}: template.pdf not read — ${e.message}`) }
  }

  if (first) {
    await task(db, p.id, `Chosen on Musaned: ${p.full_name}`, `Contract ${update.contract_number || ''} · ${update.employer_name || ''} · ${update.musaned_stage || ''}. Wafid medical booking started.`)
    try { const { queueWafidBooking } = await import('./wafidStatus.js'); await queueWafidBooking(db, p.id, 'chosen') } catch (e) { console.warn('[contracts] wafid:', e.message) }
    import('./whatsapp.js').then(w => w.onChosen(db, p.id)).catch(e => console.warn('[contracts] whatsapp:', e.message))
  } else if (dead && p.chosen_at && !/CANCEL|REJECT/i.test(p.musaned_stage || '')) {
    await task(db, p.id, `Musaned: ${p.full_name}'s contract was ${update.musaned_stage}`, `Contract ${update.contract_number || ''} · ${update.employer_name || ''}. She is free for another employer.`)
  } else if (p.musaned_stage && update.musaned_stage && p.musaned_stage !== update.musaned_stage) {
    await task(db, p.id, `Musaned: ${p.full_name} → ${update.musaned_stage}`, `Was ${p.musaned_stage}.`)
  }
  // Wakala unpaid → the agent who chose her is asked (a call that opens their WhatsApp).
  if (!dead && /^unpaid$/i.test(update.musaned_payment || '')) import('./wakala.js').then(w => w.askToPay(db, p.id)).catch(e => console.warn('[contracts] wakala:', e.message))
  return { state: 'chosen', stage: update.musaned_stage, contract: update.contract_number, pdfs: saved, first }
}

/**
 * The "Check if chosen" run (musaned_check_chosen): the run has signed in to
 * Musaned in its own tab; look her passport up there the same way.
 * Returns the worker's result.
 */
export async function checkChosenInRun(page, ctx) {
  const db = ctx.db
  const p = await db('profiles').where('id', ctx.profileId).first()
  if (!p?.passport_number) return { ok: false, error: 'Profile is missing the passport number' }
  page.__adalAllowImages = true
  // The whole chosen list, as Musaned's page reads it (no passport search): she
  // is on it or not, and every other new girl on it is added as well.
  ctx.onLog?.('info', '🔎 Employment Requests → the chosen list')
  const all = await scanListByApi(db, page, { log: (m) => ctx.onLog?.('info', m), onlyId: p.id }).catch(e => ({ ok: false, why: e.message }))
  if (all.ok) {
    const mine = all.results.find(x => x.id === p.id)
    if (!mine) {
      await db('profiles').where('id', p.id).update({ contract_checked_at: new Date().toISOString() })
      ctx.onLog?.('info', 'Not on the chosen list — nobody has chosen her yet')
      return { ok: true, done: true, note: 'not chosen yet' }
    }
    if (mine.state === 'error') return { ok: false, error: mine.error }
    const note = mine.unchanged
      ? 'Chosen on Musaned · ' + (mine.stage || '') + ' (nothing new)'
      : 'Chosen on Musaned — contract ' + (mine.contract || '?') + ' · ' + (mine.stage || '') + (mine.pdfs?.length ? ' · ' + mine.pdfs.length + ' PDF(s) saved' : '')
    ctx.onLog?.('info', '✅ ' + note)
    if (mine.first) await ctx.notify?.('🎉 ' + ctx.profileName + ': chosen by an employer on Musaned', note)
    return { ok: true, done: true, note }
  }
  ctx.onLog?.('warn', 'Musaned list data not read (' + all.why + ') — searching her passport instead')
  const r = await checkOne(db, page.browser(), page, p)
  if (r.state === 'signed-out') return { ok: false, error: 'Musaned signed out during the check' }
  if (r.state === 'not-chosen') {
    ctx.onLog?.('info', 'No employment request with her passport — nobody has chosen her yet')
    return { ok: true, done: true, note: 'not chosen yet' }
  }
  const msg = `Chosen on Musaned — contract ${r.contract || '?'} · ${r.stage || ''}${r.pdfs?.length ? ` · ${r.pdfs.length} PDF(s) saved (${r.pdfs.join(', ')})` : ''}`
  ctx.onLog?.('info', `✅ ${msg}`)
  if (r.first) await ctx.notify?.(`🎉 ${ctx.profileName}: chosen by an employer on Musaned`, msg)
  return { ok: true, done: true, note: msg }
}

/**
 * EPRO approve (after Wafid FIT): Employment Requests (or Pending) → her
 * passport → DETAILS → APPROVE → the agency's signed contract in Contract
 * Upload. SAVE is never pressed — a person looks it over, ticks the pledge and
 * saves; Adal Keep rings for it (with its sound).
 */
export async function eproApproveInRun(page, ctx) {
  const db = ctx.db
  const p = await db('profiles').where('id', ctx.profileId).first()
  if (!p?.passport_number) return { ok: false, error: 'Profile is missing the passport number' }
  const { eproSignature } = await import('./eproSignature.js')
  const sig = eproSignature()
  if (!sig) return { ok: false, error: 'No signed contract yet: upload it once in Settings → Integrations → EPRO signature' }
  const passport = String(p.passport_number).trim().toUpperCase()
  page.__adalAllowImages = true
  ctx.onLog?.('info', `🔎 Employment Requests → passport ${passport}`)
  let s = await search(page, passport)
  if (s.signedOut) return { ok: false, error: 'Musaned signed out' }
  if (!s.cards?.length) {
    const sp = await search(page, passport, PENDING_URL).catch(() => ({ cards: [] }))
    if (sp.cards?.length) s = sp
  }
  if (!s.cards?.length) return { ok: false, error: 'No employment request with her passport on Musaned (nobody chose her yet?)' }
  ctx.onLog?.('info', '✓ her request found — DETAILS')
  await openDetails(page)
  // APPROVE (on the contract page, next to REJECT).
  const approve = await page.evaluateHandle(() => [...document.querySelectorAll('button, a')].find(b => /^\s*(✓\s*)?APPROVE\s*$/i.test((b.innerText || '').trim()) && b.offsetParent !== null) || null)
  if (!approve.asElement?.()) {
    const stage = await page.evaluate(() => (document.body.innerText.match(/(EPRO APPROVAL|EPRO APPROVED|FMOL APPROVAL|FMOL APPROVED|SENT TO SAUDI EMBASSY)/i) || [])[1] || '')
    return { ok: false, error: `There is no APPROVE button on her contract${stage ? ` (it is at ${stage})` : ''}: approved already?` }
  }
  await approve.asElement().click()
  ctx.onLog?.('info', '✓ APPROVE pressed — Contract Upload')
  await page.waitForFunction(() => /Contract Upload/i.test(document.body.innerText || '') && !!document.querySelector('input[type=file]'), { timeout: 20000 }).catch(() => {})
  const input = await page.$('input[type=file]')
  if (!input) return { ok: false, error: 'The Contract Upload box did not open after APPROVE' }
  await input.uploadFile(sig.path)
  await page.evaluate(() => { const i = document.querySelector('input[type=file]'); i?.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
  await sleep(2500)
  const shown = await page.evaluate((name) => (document.body.innerText || '').includes(name), sig.name).catch(() => false)
  ctx.onLog?.(shown ? 'info' : 'warn', shown ? `✓ signed contract uploaded (${sig.name}) — SAVE left for a person` : 'the signed contract was given to the upload box; check it shows before saving')
  await ctx.noteProfile?.(`EPRO: approved and the signed contract uploaded — waiting for a person to press SAVE on Musaned`).catch?.(() => {})
  await ctx.notify?.(`✍️ ${ctx.profileName}: EPRO — look it over and press SAVE`,
    'Musaned: APPROVE pressed and the signed contract uploaded in Contract Upload. Tick the pledge, look it over and press SAVE (Adal Keep never presses it).', 'warn', { login: page })
  return { ok: true, pauseReason: 'awaiting-epro-save' }
}

/** Check every profile (or one). */
/**
 * The check found Musaned signed out: open its sign-in in this tab, fill the
 * Musaned account's username and password, bring the tab to the front and
 * ring the sign-in alarm. A person types the captcha and the code; the check
 * waits up to 10 minutes. Returns true once Musaned is signed in.
 */
const SIGN_IN_TASKS = ['Musaned: sign in for the contract check', 'Sign in to Musaned for the contract check']
const doneSignInTasks = (db) => db('tasks').whereIn('title', SIGN_IN_TASKS).where({ status: 'pending' })
  .update({ status: 'completed', updated_at: new Date().toISOString() }).catch(() => {})

/**
 * Is Musaned signed in, in any Adal Keep Brave tab? The person may sign in in
 * the tab Adal Keep opened or in one of their own. Musaned's "select the
 * establishment" screen after the sign-in is picked here too (the agency
 * card, then Go to dashboard), so nobody has to tell Adal Keep "I signed in".
 */
async function musanedSignedInSomewhere(browser, log = () => {}) {
  const { snapshotState, stepClickAgencyCard, stepClickGoToDashboard } = await import('./musanedWorkflow.js')
  for (const t of await browser.pages().catch(() => [])) {
    const u = t.url()
    if (!/musaned\.com\.sa/.test(u) || /accounts\.wahid\.sa|\/realms\//.test(u)) continue
    const s = await snapshotState(t)
    if (!s || s.onKeycloak || s.hasPassword || s.hasOtp) continue
    // Signed in, Musaned asks which establishment — still on …/login.
    if (s.hasAgencyPicker) {
      log('Musaned signed in — choosing the agency')
      try { await stepClickAgencyCard(t, {}); await sleep(2500) } catch {}
      const again = await snapshotState(t)
      if (again?.hasGoToDashboard) await stepClickGoToDashboard(t, {}).catch(() => {})
      return true
    }
    if (s.hasGoToDashboard) { await stepClickGoToDashboard(t, {}).catch(() => {}); return true }
    if (/\/login|\/auth/.test(u)) continue
    if (s.hasDashboardNav || /employment-requests|dashboard/.test(u)) return true
  }
  return false
}

async function signInForCheck(db, page) {
  const acct = await db('musaned_accounts').orderBy('is_default', 'desc').first().catch(() => null)
  const log = (msg) => console.log(`[contracts] ${msg}`)
  const ctx = { musaned_username: acct?.username || '', musaned_password: acct?.password || '', account_id: acct?.id || null, onLog: (l, m) => log(m), profileName: 'Contract check' }
  const { beep } = await import('./worker.js')
  try {
    const { stepOpenMusaned, stepFillMusanedLogin } = await import('./musanedWorkflow.js')
    const open = await stepOpenMusaned(page, ctx)
    if (open.onKeycloak) {
      const f = await stepFillMusanedLogin(page, ctx)
      log(`Musaned sign-in ${f.filled ? 'filled' : 'NOT filled (no Musaned account in AI Actions)'}`)
    }
    if (await musanedSignedInSomewhere(page.browser(), log)) { log('✓ Musaned was already signed in'); return true }
    beep()
    const title = SIGN_IN_TASKS[0]
    const body = 'The name and password are filled: press Open on the notification. Type the captcha and the code — that is all: Adal Keep sees the sign-in by itself, picks the agency and goes on.'
    await task(db, null, title, body)
    const end = Date.now() + 30 * 60 * 1000
    const { typeAuthenticatorCode, classifyScreen } = await import('./musanedWorkflow.js')
    let codeAt = 0
    while (Date.now() < end) {
      await sleep(3000)
      // The code box is up and the account's authenticator is in Adal Keep: type it (once per 30 s).
      if (Date.now() - codeAt > 30000 && (await classifyScreen(page, ctx).catch(() => ({}))).screen === 'otp') {
        if (await typeAuthenticatorCode(page, ctx).catch(() => false)) codeAt = Date.now()
      }
      if (await musanedSignedInSomewhere(page.browser(), log)) {
        await doneSignInTasks(db)
        log('✓ Musaned signed in — checking goes on')
        await sleep(2000)
        return true
      }
    }
  } catch (e) { console.warn('[contracts] sign-in:', e.message) }
  return false
}

export async function checkContracts(db, { onlyId = null } = {}) {
  if (contractCheck.running) return { busy: true }
  Object.assign(contractCheck, { running: true, results: [], signedOut: false })
  let page = null
  try {
    const list = await candidates(db, onlyId)
    if (!list.length) return { checked: 0 }
    const browser = await getBrowser()
    page = await borrowTab(browser, 'musaned_check_chosen', await activeRunIds(db))
    await setupTab(page, { runId: 'musaned-contracts' })
    page.__adalAllowImages = true
    for (const [i, p] of list.entries()) {
      if (i) await sleep(BETWEEN_MS)
      let r
      try { r = await checkOne(db, browser, page, p) } catch (e) { r = { state: 'error', error: e.message } }
      contractCheck.results.push({ id: p.id, name: p.full_name, passport: p.passport_number, ...r })
      console.log(`[contracts] ${p.full_name} (${p.passport_number}): ${r.state}${r.stage ? ' · ' + r.stage : ''}${r.error ? ' — ' + r.error : ''}`)
      // Musaned signed out: fill the sign-in and ring for a person (captcha +
      // code are theirs), then go on with the same girl.
      if (r.state === 'signed-out' && await signInForCheck(db, page)) {
        try { r = await checkOne(db, browser, page, p) } catch (e) { r = { state: 'error', error: e.message } }
        contractCheck.results[contractCheck.results.length - 1] = { id: p.id, name: p.full_name, passport: p.passport_number, ...r }
      }
      if (r.state === 'signed-out') {
        contractCheck.signedOut = true
        await task(db, null, SIGN_IN_TASKS[1],
          'Adal Keep looks every 4 hours whether a Saudi employer chose a girl, but Musaned is signed out. Sign in to Musaned in Adal Browser whenever you can (captcha + code) — Adal Keep notices it by itself and checks again.')
        break
      }
    }
    if (!contractCheck.signedOut && contractCheck.results.length) await doneSignInTasks(db)
    return { checked: contractCheck.results.length, results: contractCheck.results }
  } finally {
    await doneWithTab(page).catch(() => {})
    contractCheck.running = false
    contractCheck.last = new Date().toISOString()
  }
}

// By itself every 2 hours (7:00–21:00), in the Musaned tab already open and
// signed in — never a new tab, never a sign-in prompt, never while a robot
// works (asked on 2026-11-11: the tabs are open all day now, Morning sign-in).
// New selections, and each girl's stage (EPRO → FMOL approved → embassy …).
const AUTO_MS = 2 * 3600 * 1000
let timer = null, lastAuto = 0
export function startContractChecker(db) {
  if (timer) return
  setTimeout(() => readSavedTemplates(db).catch(e => console.warn('[contracts] templates:', e.message)), 20000)
  const tick = async () => {
    const h = new Date().getHours()
    if (h < 7 || h >= 21 || contractCheck.running || Date.now() - lastAuto < AUTO_MS) return
    const working = await db('automation_queue').where('status', 'running').first('id').catch(() => null)
    if (working) return
    lastAuto = Date.now()
    const r = await scanContracts(db, { auto: true }).catch(e => ({ error: e.message }))
    if (r?.skipped) { lastAuto = Date.now() - AUTO_MS + 15 * 60000; console.log(`[contracts] automatic check waits: ${r.why}`) }  // again in 15 minutes
    else console.log(`[contracts] automatic check: ${r?.checked ?? 0} requests${r?.newlyChosen?.length ? `, newly chosen: ${r.newlyChosen.join(', ')}` : ''}${r?.error ? ` — ${r.error}` : ''}`)
  }
  setTimeout(() => tick().catch(() => {}), 5 * 60000)
  timer = setInterval(() => tick().catch(() => {}), 5 * 60000)
  timer.unref?.()
}

// ---------------------------------------------------------------------------
// The chosen list as Musaned's own page reads it (asked on 2026-11-13): no
// passport is searched. Employment Requests' data (api-tawtheeq…/api/search/
// employment, newest first, 200 at a time) holds every request with the
// passport, the stage, the visa and order numbers and her HR-pool record. A
// request new to Adal Keep — or whose stage moved — is opened straight at its
// contract page (details and PDFs, as before). A girl on the list who is not
// in Adal Keep gets her profile: every detail of the contract's candidate,
// her photo and her passport scan (her HR-pool record), then the contract.
// Nothing on Musaned is changed: it only reads.
// ---------------------------------------------------------------------------
const API = 'https://api-tawtheeq.musaned.com.sa'
const STAGE_OF = {
  EPRO_APPROVAL_PENDING: 'EPRO APPROVAL', EPRO_APPROVED: 'EPRO APPROVED', FMOL_APPROVAL_PENDING: 'FMOL APPROVAL',
  FMOL_APPROVED: 'FMOL APPROVED', SENT_TO_MOFA: 'SENT TO SAUDI EMBASSY', VISA_ISSUED: 'VISA ISSUED', ARRIVED_KSA: 'ARRIVED KSA',
  ARRIVED: 'ARRIVED KSA', REJECTED: 'REJECTED', CANCELLED: 'CANCELED', CANCELED: 'CANCELED', VISA_CANCELLED: 'VISA CANCELED',
  VISA_CANCELED: 'VISA CANCELED', OUTSIDE_KSA: 'OUTSIDE KSA',
}
export const stageOfStatus = (s) => STAGE_OF[String(s || '').toUpperCase()] || String(s || '').toUpperCase().replace(/_PENDING$/, '').replace(/_/g, ' ')

/** One request of the list, as the card the rest of this file knows. */
export function cardOfRow(r) {
  const pay = String(r.paymentStatus || '').toUpperCase()
  return {
    stage: stageOfStatus(r.status),
    contract_number: String(r.orderNumber || ''),
    visa_number: String(r.visaNumber || ''),
    employer_id: String(r.employerIdNumber || ''),
    employer_name: [r.employerFirstNameEn, r.employerLastNameEn].filter(Boolean).join(' ').toUpperCase(),
    candidate: String(r.candidateName || '').toUpperCase(),
    passport: String(r.passportNumber || '').toUpperCase().replace(/\s+/g, ''),
    job: r.careerNameEn || '',
    pro: r.proNameEn || '',
    payment: pay === 'PAID' ? 'Paid' : pay === 'UNPAID' ? 'Unpaid' : (r.paymentStatus || ''),
    created: String(r.createdAt || '').slice(0, 10),
    id: r.id, candidateId: r.candidateId,
  }
}

/** The headers Musaned's own page sends (its sign-in, role, organization): seen once the list loads. */
async function apiHeadersOf(page) {
  let H = null
  const on = (r) => { const h = r.headers(); if (r.url().startsWith(API) && h.authorization && h['app-organization']) H = Object.fromEntries(Object.entries(h).filter(([k]) => /^(authorization|app-|accept-language)/.test(k))) }
  page.on('request', on)
  try {
    await page.goto('https://tawtheeq.musaned.com.sa/employment-requests?sort=createdAt,DESC&page=0&size=10', { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {})
    for (let i = 0; i < 20 && !H; i++) await sleep(500)
  } finally { page.off('request', on) }
  return H
}

/** GET from Musaned's data address inside the page (its own sign-in): JSON, or { b64, type } for a picture. */
function apiGet(page, H, url, { binary = false } = {}) {
  return page.evaluate(async (A, H, url, binary) => {
    const r = await fetch(A + url, { headers: { ...H, Accept: binary ? '*/*' : 'application/json' } })
    if (!r.ok) return { status: r.status }
    if (!binary) return { status: 200, json: await r.json() }
    const b = new Uint8Array(await r.arrayBuffer())
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
    return { status: 200, type: r.headers.get('content-type') || '', b64: btoa(s) }
  }, API, H, url, binary)
}

/** Her photo and passport scan from her HR-pool record, each into its own document (only what she lacks). */
async function savePictures(db, page, H, profileId, candidateId, passport) {
  if (!candidateId) return []
  const { saveOnProfile } = await import('./musanedImport.js')
  const os = await import('os')
  const saved = []
  let lastHash = null
  // Musaned keeps her photo only (asked for her passport it gives the same photo).
  for (const [kind, field] of [['PERSONAL', 'Photo']]) {
    const has = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
      .where({ 'profile_fields.profile_id': profileId, 'profile_fields.name': field }).first('files.id').catch(() => null)
    if (has) continue
    // Full size (without it Musaned gives a small copy).
    const r = await apiGet(page, H, `/api/hrpool/${candidateId}/photo/${kind}?size=ORIGINAL`, { binary: true }).catch(() => null)
    if (r?.status !== 200 || !r.b64) continue
    const buf = Buffer.from(r.b64, 'base64')
    const hash = crypto.createHash('sha1').update(buf).digest('hex')
    // Musaned keeps one picture per girl (her photo) and gives it for every kind:
    // the same picture again is not filed as her passport.
    if (hash === lastHash) continue
    lastHash = hash
    const ext = /png/i.test(r.type) ? '.png' : /webp/i.test(r.type) ? '.webp' : /pdf/i.test(r.type) ? '.pdf' : '.jpg'
    const name = `${passport || profileId}-Musaned-${field}${ext}`
    const file = path.join(os.tmpdir(), `${Date.now()}-${name}`)
    fs.writeFileSync(file, buf)
    try { if (await saveOnProfile(db, profileId, field, file, name)) saved.push(field) } finally { fs.rmSync(file, { force: true }) }
  }
  return saved
}

/** A girl on the list who is not in Adal Keep: her profile from the contract's candidate (every detail). */
async function profileFromRequest(db, page, H, card) {
  const { fieldsFromMusaned } = await import('./musanedImport.js')
  const det = (await apiGet(page, H, `/api/employment/${card.id}`).catch(() => null))?.json || {}
  const c = det.candidate || {}
  const hr = card.candidateId ? (await apiGet(page, H, `/api/hrpool/${card.candidateId}`).catch(() => null))?.json || {} : {}
  const f = Object.fromEntries(Object.entries(fieldsFromMusaned({ ...hr, ...c })).filter(([, v]) => v))
  const now = new Date().toISOString()
  const company = await db('companies').first('id').catch(() => null)
  // The fullest form of her name (the contract sometimes has her first name only).
  const name = [f.full_name, card.candidate, hr.name, c.name].map(x => String(x || '').trim().toUpperCase()).sort((a, b) => b.split(/s+/).length - a.split(/s+/).length || b.length - a.length)[0] || ''
  const words = name.split(/\s+/).filter(Boolean)
  const row = {
    ...f, full_name: name, status: 'active', nationality: 'Ethiopian',
    passport_number: card.passport || String(c.passportNumber || '').toUpperCase() || null,
    first_name: words[0] || null, last_name: words.slice(1).join(' ') || null,
    place_of_birth: c.passportIssuePlace || hr.passportIssuePlace || null,
    job_title: card.job || null,
    notes: `Added from the Musaned list (contract ${card.contract_number}) — not in Adal Keep before. Her details, photo and passport came from Musaned.`,
    company_id: company?.id || 1, created_by: 'Musaned list', created_at: now, updated_at: now,
  }
  for (const k of Object.keys(row)) if (row[k] === null || row[k] === '') delete row[k]
  const cols = await db('profiles').columnInfo().catch(() => null)
  if (cols) for (const k of Object.keys(row)) if (!(k in cols)) delete row[k]
  const [id] = await db('profiles').insert(row)
  await task(db, id, `On Musaned, added to Adal Keep: ${name}`, `She was on the Musaned list (${card.stage || 'request'}, contract ${card.contract_number}) but not in Adal Keep. Her profile was made from Musaned with her photo and passport — look it over.`)
  return db('profiles').where('id', id).first()
}

/** Her contract page, opened straight (no search) and read. */
async function openContract(page, card) {
  await page.goto(`https://tawtheeq.musaned.com.sa/employment-requests/contract/${card.id}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await page.waitForFunction(() => /Contract\s*#\s*\d+/i.test(document.body.innerText || ''), { timeout: 30000 }).catch(() => {})
  await page.evaluate(() => [...document.querySelectorAll('button, a, span, div')].filter(e => /^\s*Expand\s*$/i.test(e.textContent || '') && e.children.length <= 2).forEach(e => e.click())).catch(() => {})
  await sleep(1200)
  return page.evaluate(readDetails)
}

/**
 * The whole list through Musaned's data (in a signed-in Musaned tab): every
 * new or moved request saved, every girl not in Adal Keep added. Returns
 * { ok, checked, results, added } — or { ok: false, why } when the data
 * cannot be read (the caller falls back to the page).
 */
// onlyId: one girl's check (her row only; nothing else is opened or added).
// addLimit: at most this many girls added per round (the next round goes on),
// so a first check of a long list never takes hours in one go.
export async function scanListByApi(db, page, { log = () => {}, maxPages = 10, onlyId = null, addLimit = 40 } = {}) {
  const H = await apiHeadersOf(page)
  if (!H) return { ok: false, why: 'Musaned did not answer as signed in' }
  const browser = page.browser()
  let profiles = await db('profiles').select('*')
  const results = [], added = []
  let checked = 0, more = false
  const only = onlyId ? profiles.find(x => x.id === Number(onlyId)) : null
  const onlyPassport = only ? String(only.passport_number || '').toUpperCase().replace(/\s+/g, '') : ''
  for (let n = 0; n < maxPages; n++) {
    const r = await apiGet(page, H, `/api/search/employment?sort=createdAt,DESC&page=${n}&size=200`)
    if (r.status !== 200) return n ? { ok: true, checked, results, added } : { ok: false, why: `Musaned answered ${r.status}` }
    const rows = r.json?.content || []
    if (!rows.length) break
    let anyNew = false
    for (const row of rows) {
      checked++
      const card = cardOfRow(row)
      let p = matchCard(card, profiles)
      // A girl this check added with a shorter name than the list's: her full name now.
      if (p && p.created_by === 'Musaned list' && card.candidate && card.candidate.split(/s+/).length > String(p.full_name || '').split(/s+/).length) {
        const w = card.candidate.split(/s+/)
        await db('profiles').where('id', p.id).update({ full_name: card.candidate, first_name: w[0], last_name: w.slice(1).join(' '), updated_at: new Date().toISOString() }).catch(() => {})
        log(`${p.full_name} → ${card.candidate} (her full name from the list)`)
        p = { ...p, full_name: card.candidate }
        profiles = profiles.map(x => x.id === p.id ? p : x)
      }
      if (only && !(p?.id === only.id || (onlyPassport && card.passport === onlyPassport))) continue
      if (only && !p) p = only
      if (p && !cardIsNew(p, card)) { results.push({ id: p.id, name: p.full_name, state: 'chosen', stage: card.stage, unchanged: true }); continue }
      if (!p && /CANCEL|REJECT/i.test(card.stage)) continue        // someone else's request that ended: nothing to add
      anyNew = true
      try {
        let made = false
        if (!p) {
          if (added.length >= addLimit) { more = true; continue }
          p = await profileFromRequest(db, page, H, card); made = true; profiles.push(p); added.push({ id: p.id, name: p.full_name, stage: card.stage })
        }
        const pics = await savePictures(db, page, H, p.id, card.candidateId, card.passport)
        await sleep(BETWEEN_MS / 2)
        const d = await openContract(page, card)
        const res = await saveDetails(db, browser, page, p, card, JSON.stringify(row), d)
        results.push({ id: p.id, name: p.full_name, passport: p.passport_number, ...res, added: made, pictures: pics })
        log(`${p.full_name}: ${made ? 'added from Musaned' : res.first ? 'newly chosen' : 'updated'} · ${card.stage}${pics.length ? ` · ${pics.join(' and ')} saved` : ''}`)
        profiles = profiles.map(x => x.id === p.id ? { ...x, musaned_stage: card.stage, contract_number: x.contract_number || card.contract_number, chosen_at: x.chosen_at || new Date().toISOString() } : x)
      } catch (e) {
        results.push({ id: p?.id, name: p?.full_name || card.candidate, state: 'error', error: e.message })
        log(`${p?.full_name || card.candidate}: ${e.message}`)
      }
    }
    // Her row found (one girl's check), or a whole page with nothing new: done.
    if (only && results.some(x => x.id === only.id)) break
    if ((!only && !anyNew) || rows.length < 200) break
  }
  if (more) log(`more girls on Musaned are not in Adal Keep yet — the next check adds the next ${addLimit}`)
  return { ok: true, checked, results, added, more }
}
