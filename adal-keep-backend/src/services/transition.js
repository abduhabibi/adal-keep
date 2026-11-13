/**
 * transition.js — an agency moving to Adal Keep brings everything with it
 * (Settings → Transitions): EasyEnjaz, EnjazPlus, Musaned or its Pextran.
 *
 *   1. The site opens in a window of its own and a person signs in there:
 *      Adal Keep never sees or keeps the password. The window then goes away.
 *   2. Every list page is visited. What the site's own pages ask its server for
 *      is read, and each list is then read to its last page, the same way.
 *      Pages drawn on the server are read from their tables.
 *   3. Whoever has a passport number becomes a profile, or fills the empty
 *      fields of the profile with that number: nothing typed here is replaced.
 *      Her photos and documents come with her.
 *   4. CVs found there become CV templates (cvTemplateIngest).
 *
 * The sites differ and change, so nothing here depends on one site's layout:
 * people are recognised by a passport number under a passport key. Everything
 * read is also kept in data/transitions/, so a field not mapped yet is not lost.
 *
 * Only reads. No form is sent and no button is pressed but "next page"; a list
 * sent by POST is read again only when its address says it is a search.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { getBrowser, openForPerson, sendAway } from './browser.js'
import { saveOnProfile } from './musanedImport.js'
import { copyEasyEnjaz, signedInToken } from './easyEnjazCopy.js'
import { copyEnjazPlus, signedInEnjazPlus } from './enjazPlusCopy.js'
import { copyMusaned, signedInMusaned, listen as listenMusaned } from './musanedCopy.js'
import { keepAwake } from './awake.js'
import { collectBrokers, saveBrokers } from './siteBrokers.js'

export const SOURCES = {
  // Its API is known, so it is asked directly: see easyEnjazCopy.js.
  // EasyEnjaz: no longer offered (2026-11-10); its code stays in easyEnjazCopy.js.
  // Its data through its own GraphQL, with the window's sign-in: every employee of every tab, with her files.
  enjazplus: { name: 'EnjazPlus', url: 'https://v2.enjazplus.com/app/employees', deep: copyEnjazPlus, token: signedInEnjazPlus },
  musaned: {
    name: 'Musaned', url: 'https://tawtheeq.musaned.com.sa/', start: ['/hr-pool'],
    // Everyone in the HR pool through Musaned's own list; its window stays open (its token is kept fresh there).
    deep: copyMusaned, token: signedInMusaned, keepTab: true,
    // Her pictures are not in her record: Musaned serves them by her id.
    files: (r, origin) => r.id ? [
      { field: 'Passport', url: `${origin}/api/hrpool/${r.id}/photo/PASSPORT` },
      { field: 'Photo', url: `${origin}/api/hrpool/${r.id}/photo/PERSONAL` },
    ] : [],
  },
  pextran: {
    name: 'Pextran', url: null, start: ['/recruits', '/brokers'],
    // Nothing else is opened (submissions, finance, batches …).
    only: /^\/(recruits|brokers)\/?$/i,
    // A broker is someone in its broker list — never a person, a photo record or a partner agency.
    brokersFrom: /\/api\/brokers(\/|\?|$)/i,
  },
}

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'transitions')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const SIGN_IN_WAIT = 15 * 60_000
const MAX_PAGES = 40, MAX_REQUESTS = 3000, MAX_TEMPLATES = 5

const states = new Map()
const windows = new Map()     // a system → the window a person signs in to
const blank = () => ({ status: 'idle', step: '', people: 0, created: 0, updated: 0, files: 0, templates: 0, brokers: 0, skipped: 0, failed: 0, error: null, folder: null })
const stateOf = (id) => states.get(id) || blank()
const set = (id, patch) => { states.set(id, { ...stateOf(id), ...patch }); return states.get(id) }

export const transitionStates = () => Object.fromEntries(Object.entries(SOURCES).map(([id, s]) => {
  const { stop, ...st } = stateOf(id)
  return [id, { ...st, name: s.name }]
}))

/** The sign-in window, when it went behind another. */
export async function showTransition(id) {
  await windows.get(id)?.bringToFront()
}

/** A copy is using the line: the online copy waits, as it does for a run. */
export const transitionRunning = () => [...states.values()].some(s => ['signing-in', 'copying'].includes(s.status))

export function stopTransition(id) {
  if (['signing-in', 'copying'].includes(stateOf(id).status)) set(id, { stop: true, step: 'Stopping…' })
}

/** A Pextran address: only https on pextran.com, reduced to the site itself. */
export function checkLink(link) {
  let u
  try { u = new URL(/^https?:\/\//i.test(String(link || '').trim()) ? String(link).trim() : `https://${String(link || '').trim()}`) }
  catch { throw new Error('Paste the Pextran address, for example https://zadulmead.agency.pextran.com/') }
  if (!/(^|\.)pextran\.com$/i.test(u.hostname)) throw new Error('That is not a Pextran address (it ends in pextran.com)')
  // The sign-in page's address carries the agency's own one.
  const back = u.searchParams.get('callbackUrl') || u.searchParams.get('callbackurl')
  if (back) { try { const b = new URL(back); if (/(^|\.)pextran\.com$/i.test(b.hostname)) u = b } catch {} }
  let host = u.hostname.toLowerCase()
  const m = host.match(/^([a-z0-9-]+)\.(?:(?:home|tenant|finance|app|www)\.)?pextran\.com$/)
  if (m && !/^(www|home|tenant|finance|app|agency|api)$/.test(m[1])) host = `${m[1]}.agency.pextran.com`
  if (!/^[a-z0-9-]+\.agency\.pextran\.com$/.test(host)) throw new Error('Paste your agency\'s own Pextran address, for example https://zadulmead.agency.pextran.com/')
  return `https://${host}/`
}

// ── Reading a person out of whatever shape the site uses ─────────────────────
const KEYS = {
  full_name: ['fullname', 'fullnameen', 'nameen', 'englishname', 'candidatename', 'workername', 'applicantname', 'employeename', 'name'],
  first_name: ['firstname', 'givenname', 'givennames'],
  middle_name: ['middlename'],
  last_name: ['lastname', 'surname', 'familyname'],
  passport_number: ['passportnumber', 'passportno', 'passportnum', 'passport'],
  phone_number: ['phonenumber', 'phone', 'mobilenumber', 'mobile', 'contactnumber', 'telephone'],
  national_id: ['nationalid', 'faydaid'],
  date_of_birth: ['dateofbirth', 'birthdate', 'dob'],
  nationality: ['nationality'],
  religion: ['religion'],
  gender: ['gender', 'sex'],
  marital_status: ['maritalstatus'],
  place_of_birth: ['placeofbirth', 'birthplace'],
  passport_issue_date: ['passportissuedate', 'passportdateofissue', 'dateofissue', 'issuedate'],
  passport_expiry_date: ['passportexpirydate', 'passportexpirationdate', 'passportexpiry', 'dateofexpiry', 'expirydate', 'expirationdate'],
  children_count: ['childrencount', 'numberofchildren', 'noofchildren', 'children'],
  weight: ['weight'], height: ['height'], complexion: ['complexion'],
  education_level: ['educationlevel', 'education'],
  job_title: ['jobtitle', 'job', 'profession', 'occupation', 'position'],
  salary: ['salary', 'monthlysalary', 'desiredsalary'],
  mother_name: ['mothername'], father_name: ['fathername'], spouse_name: ['spousename'],
  region: ['region'], living_town: ['livingtown', 'city'],
  labor_id: ['laborid', 'labourid'],
  visa_number: ['visanumber', 'visano'],
  contract_number: ['contractnumber', 'contractno'],
  employer_name: ['employername', 'sponsorname'],
  emergency_name: ['emergencyname', 'emergencycontactname', 'emmergencycontactname'],
  emergency_phone: ['emergencyphone', 'emergencycontactphone', 'emmergencycontactphone'],
}
const WANT = new Map(Object.entries(KEYS).flatMap(([col, ks]) => ks.map((k, i) => [k, { col, rank: i }])))
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
const PASSPORT = /^[A-Z]{1,3}\d{6,9}$/
const plain = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v.nameEn ?? v.name ?? v.label ?? v.title ?? v.value
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
}

/** Every value of an object with its path, nearest first. */
function flatten(obj, depth = 3, at = []) {
  const out = [], deeper = []
  for (const [k, v] of Object.entries(obj || {})) {
    // A named record that is more than a name (Pextran's emergency contact: name, phone, address) is read inside.
    const person = v && typeof v === 'object' && Object.keys(v).some(x => /^phone|address$/i.test(x))
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 1 && (!plain(v) || person)) deeper.push([k, v])
    else out.push([[...at, k], v])
  }
  for (const [k, v] of deeper) out.push(...flatten(v, depth - 1, [...at, k]))
  return out
}

function date(v) {
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/) // day first, as printed in Ethiopia and Saudi Arabia
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

/** The profile columns in one record, or null when it is not a person with a passport. */
export function readPerson(obj) {
  const found = {}, rank = {}
  for (const [keys, v] of flatten(obj)) {
    const last = norm(keys[keys.length - 1]), two = keys.length > 1 ? norm(keys.slice(-2).join('')) : ''
    const hit = WANT.get(two) || WANT.get(last)
    const value = plain(v)
    if (!hit || !value) continue
    if (found[hit.col] && rank[hit.col] <= hit.rank) continue
    found[hit.col] = value; rank[hit.col] = hit.rank
  }
  const passport = (found.passport_number || '').toUpperCase().replace(/\s/g, '')
  if (!PASSPORT.test(passport)) return null
  found.passport_number = passport
  if (!found.full_name) found.full_name = [found.first_name, found.middle_name, found.last_name].filter(Boolean).join(' ')
  if (!found.full_name) return null
  for (const c of ['date_of_birth', 'passport_issue_date', 'passport_expiry_date']) {
    if (!found[c]) continue
    const d = date(found[c])
    if (d) found[c] = d; else delete found[c]
  }
  return found
}

/** Everyone in an answer, however deep. */
export function findPeople(json, out = [], depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return out
  if (Array.isArray(json)) { for (const v of json) findPeople(v, out, depth + 1); return out }
  for (const k of ['data', 'result', 'item', 'record', 'payload']) {
    const inner = json[k]
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && readPerson(inner)) return findPeople(inner, out, depth + 1)
  }
  const p = readPerson(json)
  if (p) { out.push({ person: p, raw: json }); return out }
  for (const v of Object.values(json)) findPeople(v, out, depth + 1)
  return out
}

const FIELD_OF = [
  [/passport.?size|size.?photo|headshot|profile.?(photo|picture|image)/i, 'Photo'],
  [/full.?body|fullbody|body.?photo|long.?photo/i, 'Full Body Photo'],
  [/medical/i, 'Medical Report'],
  [/visa/i, 'Visa'],
  [/contract/i, 'Contract'],
  [/\bcv\b|resume|^cv|cv$/i, 'CV'],
  [/passport/i, 'Passport'],
  [/photo|image|picture|avatar|face|personal/i, 'Photo'],
]
const IS_FILE = /\.(jpe?g|png|webp|pdf)(\?|#|$)/i

/** The files a record points to: { field, url }. */
export function filesOf(raw, origin) {
  const out = [], seen = new Set()
  for (const [keys, v] of flatten(raw, 4)) {
    if (typeof v !== 'string' || !v || v.length > 2000) continue
    const key = keys.join('.')
    const looks = IS_FILE.test(v) || (/^(https?:\/\/|\/)/.test(v) && /photo|image|picture|file|document|attachment/i.test(key))
    if (!looks) continue
    const field = FIELD_OF.find(([re]) => re.test(key))?.[1]
    if (!field) continue
    let url
    try { url = new URL(v, origin).href } catch { continue }
    if (!seen.has(url)) { seen.add(url); out.push({ field, url }) }
  }
  for (const list of [raw?.medias, raw?.media, raw?.attachments, raw?.documents, raw?.files]) {
    if (!Array.isArray(list)) continue
    for (const m of list) {
      if (!m || typeof m !== 'object' || m.deleted) continue
      const link = m.signedUrl || m.url || m.pdfSignedUrl || m.pdfUrl || m.fileUrl
      if (typeof link !== 'string' || !link) continue
      const label = [m.category, m.type, m.name, m.description].filter(v => typeof v === 'string').join(' ')
      const field = FIELD_OF.find(([re]) => re.test(label))?.[1] || 'Other'
      let url
      try { url = new URL(link, origin).href } catch { continue }
      if (!seen.has(url)) { seen.add(url); out.push({ field, url, label }) }
    }
  }
  return out
}

/** The address of the next page of a list, or null. */
export function nextPage(url, json, count) {
  if (typeof json?.next === 'string' && json.next) return new URL(json.next, url).href // Django style
  const u = new URL(url), q = u.searchParams
  const key = (re) => [...q.keys()].find(k => re.test(k))
  const page = key(/^(page|pagenumber|pageno|pageindex|p)$/i)
  if (page) { q.set(page, String(Number(q.get(page) || 0) + 1)); return u.href }
  const off = key(/^(offset|skip|start)$/i)
  if (off) { q.set(off, String(Number(q.get(off) || 0) + count)); return u.href }
  // No paging in the address, but the answer says there is more.
  const total = Number(json?.total ?? json?.totalCount ?? json?.totalElements ?? json?.count ?? json?.meta?.total ?? json?.pagination?.total ?? 0)
  if (total > count) { q.set('page', '2'); return u.href }
  return null
}

// ── In the site's tab ───────────────────────────────────────────────────────
const onSignIn = (page) => page.evaluate(() => {
  const seen = [...document.querySelectorAll('input[type="password"]')].some(i => i.offsetParent !== null)
  return seen || /\/(login|log-in|signin|sign-in|auth|realms)([\/?_-]|$)/i.test(location.pathname)
}).catch(() => true)

/** One read from the site as its own page would ask: its sign-in comes along. */
const ask = (page, url, headers, binary = false, init = {}) => page.evaluate(async (url, headers, binary, init) => {
  const r = await fetch(url, { credentials: 'include', headers, ...init })
  if (!r.ok) return null
  if (!binary) return { text: await r.text(), type: r.headers.get('content-type') || '' }
  const buf = new Uint8Array(await r.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return { base64: btoa(s), type: r.headers.get('content-type') || '' }
}, url, headers, binary, init).catch(() => null)

/** Lists drawn on the page itself: each table row as { header: cell }. */
const readTables = (page) => page.evaluate(() => [...document.querySelectorAll('table')].flatMap(t => {
  const heads = [...t.querySelectorAll('thead th, thead td')].map(h => h.innerText.trim())
  if (!heads.length) return []
  return [...t.querySelectorAll('tbody tr')].map(r => Object.fromEntries([...r.cells].map((c, i) => { const img = c.querySelector('img'); return [heads[i] || `c${i}`, c.innerText.trim() || (img && (img.currentSrc || img.src)) || ''] })))
})).catch(() => [])

const links = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href))]).catch(() => [])
const AVOID = /log.?out|sign.?out|delete|remove|destroy|edit|create|\/new|\/add|settings|billing|payment/i
const PEOPLE = /broker|candidat|worker|cv|employee|applicant|maid|hr-pool|recruit|labou?r|people|profile|template/i
const hasId = (p) => /\/(\d+|[0-9a-f]{16,}|[0-9a-f-]{32,})(\/|$)/i.test(p)

const pressNext = (page) => page.evaluate(() => {
  const seen = (e) => e.offsetParent !== null && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(e.className + (e.parentElement?.className || ''))
  const b = [...document.querySelectorAll('a[rel="next"], [aria-label*="next" i], li.next a, .pagination a, .pagination button, nav button')]
    .filter(seen).find(e => e.rel === 'next' || /next/i.test(e.getAttribute('aria-label') || '') || /^(next|›|»|>)$/i.test(e.innerText.trim()) || e.parentElement?.className?.includes?.('next'))
  if (!b) return false
  b.click()
  return true
}).catch(() => false)

/**
 * Musaned with a saved account: the same steps the robots use — Login, its
 * username and password (as saved in Portals), the agency's own card, the
 * dashboard. A picture code, if Musaned shows one, is typed by the person in
 * the window; the copy waits for the sign-in as always and then goes on.
 */
export async function musanedSignIn(db, page, accountId, say, check) {
  const acct = await db('musaned_accounts').where('id', Number(accountId)).first().catch(() => null)
  if (!acct?.username || !acct?.password) return
  const w = await import('./musanedWorkflow.js')
  const ctx = { db, account_id: acct.id, musaned_username: acct.username, musaned_password: acct.password, musaned_name: acct.name, runId: 'move', profileId: '-' }
  page.__adalMusanedCtx = ctx // the HR pool is reached through this agency's own card
  try {
    say(`Signing in to Musaned as ${acct.name}…`)
    // Musaned moves to its sign-in page while it is looked at ("detached frame"): look again.
    let opened = null
    for (let i = 0; i < 3 && !opened; i++) {
      opened = await w.stepOpenMusaned(page, ctx).catch(async (e) => { if (!/detached|Execution context/i.test(e.message) || i === 2) throw e; await sleep(2000); return null })
    }
    if (opened.onKeycloak) {
      const f = await w.stepFillMusanedLogin(page, ctx)
      if (f.captcha) say(`${acct.name} is filled in: type the picture's letters in the Musaned window and press Log in`)
    }
    // Signed in: Musaned shows its agencies — this account's own card, then the dashboard.
    // (Up to 30 minutes: the person types the picture's letters when they get to it.)
    let denied = 0
    for (const end = Date.now() + 30 * 60_000; Date.now() < end;) {
      check()
      // Signed in already (by the person, or Musaned in Arabic): a Musaned page that is not the sign-in.
      const at = (() => { try { return new URL(page.url()) } catch { return null } })()
      // Musaned's "Access Denied" (/403): a page opened before the agency was chosen.
      // Back to its front page, where the agency's own card is chosen again.
      if (at && at.host === 'tawtheeq.musaned.com.sa' && /^\/403\b/.test(at.pathname)) {
        if (++denied > 3) { say('Musaned keeps saying "Access Denied": choose the agency on the first Musaned page in that window'); return }
        say('Musaned said "Access Denied" — choosing the agency again')
        await page.goto('https://tawtheeq.musaned.com.sa/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await sleep(3000)
        continue
      }
      if (at && at.host === 'tawtheeq.musaned.com.sa' && /^\/(hr-pool|employment-requests|dashboard|candidates|contracts|organizations)/.test(at.pathname)) return
      const s = await w.snapshotState(page).catch(() => null)
      // The agency's card first: "Organizations" is on that page too, and the HR pool opened before it is "Access Denied".
      if (s?.hasAgencyPicker) { await w.stepClickAgencyCard(page, ctx).catch(() => {}); await w.stepClickGoToDashboard(page, ctx).catch(() => {}); return }
      if (s?.hasGoToDashboard && !s?.hasDashboardNav) { await w.stepClickGoToDashboard(page, ctx).catch(() => {}); return }
      if (s?.hasDashboardNav) return
      await sleep(1500)
    }
  } catch (e) {
    if (e.stopped) throw e
    console.warn('[transition musaned] sign-in with the saved account:', e.message)
    say('Sign in to Musaned in the window that opened')
  }
}

// ── The copy ────────────────────────────────────────────────────────────────
export function startTransition(db, id, link, deps = {}) {
  const source = deps.source || SOURCES[id]
  if (!source) throw new Error('Unknown system')
  if (['signing-in', 'copying'].includes(stateOf(id).status)) return stateOf(id)
  const url = link || source.url
  if (!url) throw new Error('Paste the address first')
  set(id, { ...blank(), status: 'signing-in', step: `Sign in to ${source.name} in the window that opened`, site: url })
  // A move takes hours on a slow line: the PC must not sleep in the middle.
  const letSleep = (deps.keepAwake || keepAwake)(`moving from ${source.name}`)
  run(db, id, source, url, deps).finally(letSleep).then(async () => {
    // Done: what came in is backed up as soon as no agent is working.
    try { (await import('./telegramBackup.js')).backupSoon() } catch {}
  }).catch(e => {
    console.error(`[transition ${id}]`, e)
    set(id, { status: e.stopped ? 'stopped' : 'failed', step: '', error: e.stopped ? null : e.message })
  })
  return stateOf(id)
}

async function run(db, id, source, url, deps) {
  const check = () => { if (stateOf(id).stop) { const e = new Error('Stopped'); e.stopped = true; throw e } }
  const browser = deps.browser || await getBrowser()
  const page = deps.page || await openForPerson()
  const folder = path.join(deps.dir || DIR, `${id}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)
  fs.mkdirSync(folder, { recursive: true })
  set(id, { folder })

  // What the site's pages ask for, read as it goes by.
  const origin = new URL(url).origin
  const people = new Map()      // passport → { person, raw }
  const lists = new Map()       // address → how to read it again
  const htmlTemplates = []
  const brokersFound = new Map() // the site's brokers, by its own id
  const brokerLists = new Map()  // the broker list's address → how to read its next pages
  const add = (found) => {
    for (const f of found) {
      const had = people.get(f.person.passport_number)
      people.set(f.person.passport_number, had ? { person: { ...f.person, ...had.person }, raw: { ...f.raw, ...had.raw } } : f)
    }
    set(id, { people: people.size })
  }
  const netLog = path.join(folder, 'network.txt')
  const keysOf = (j, d = 0) => !j || typeof j !== 'object' || d > 3 ? '' : Array.isArray(j) ? `[${j.length}]` + keysOf(j[0], d + 1) : '{' + Object.keys(j).slice(0, 60).map(k => k + (j[k] && typeof j[k] === 'object' ? keysOf(j[k], d + 1) : '')).join(',') + '}'
  const onResponse = async (r) => {
    try {
      const req = r.request()
      if (['xhr', 'fetch', 'document'].includes(req.resourceType())) {
        let shape = ''
        if (/json/i.test(r.headers()['content-type'] || '')) shape = keysOf(await r.json().catch(() => null))
        fs.appendFile(netLog, `${req.method()} ${r.status()} ${req.resourceType()} ${(r.headers()['content-type'] || '').split(';')[0]} ${r.url().replace(/[?#].*/, '')} ${shape.slice(0, 3000)}\n`, () => {})
      }
      if (!/json/i.test(r.headers()['content-type'] || '') || !['xhr', 'fetch'].includes(req.resourceType())) return
      const json = await r.json()
      const brokerList = source.brokersFrom?.test(r.url())
      if (!source.brokersFrom || brokerList) collectBrokers(json, r.url(), brokersFound)
      if (brokerList) {
        const h0 = req.headers()
        const n = [json?.data?.data, json?.data, json?.items, json?.results].find(Array.isArray)?.length || 0
        if (n && !brokerLists.has(r.url().replace(/[?#].*/, ''))) brokerLists.set(r.url().replace(/[?#].*/, ''), { url: r.url(), headers: Object.fromEntries(Object.entries(h0).filter(([k]) => k === 'authorization' || k === 'accept' || k.startsWith('x-'))), json, count: n })
        return
      }
      const found = findPeople(json)
      if (/template/i.test(r.url())) htmlTemplates.push(...templatesIn(json))
      if (!found.length) return
      add(found)
      const h = req.headers()
      const headers = Object.fromEntries(Object.entries(h).filter(([k]) => k === 'authorization' || k === 'accept' || k.startsWith('x-')))
      const post = req.method() === 'POST'
      if (post && !/search|list|filter|query|paged/i.test(r.url())) return
      if (!lists.has(r.url())) lists.set(r.url(), { headers, json, count: found.length, method: req.method(), body: req.postData() })
    } catch {}
  }
  if (!source.deep) page.on('response', onResponse)
  // Systems that send finished pages instead of data (Pextran): every list
  // table shown (a column header naming the passport) is read row by row, as
  // { header: cell } — the same people reader then knows them.
  let tableTimer = null
  if (!source.deep) {
    tableTimer = setInterval(async () => {
      if (page.isClosed?.()) return
      const rows = await page.evaluate(() => {
        const out = []
        for (const t of document.querySelectorAll('table')) {
          const head = [...(t.tHead?.rows?.[0]?.cells || t.rows?.[0]?.cells || [])].map(c => (c.innerText || '').trim())
          if (!head.some(h => /passport/i.test(h))) continue
          const body = t.tBodies?.[0] ? [...t.tBodies[0].rows] : [...t.rows].slice(1)
          for (const r of body) {
            const o = {}
            ;[...r.cells].forEach((c, i) => { if (!head[i]) return; const img = c.querySelector('img'); o[head[i]] = (c.innerText || '').trim() || (img && (img.currentSrc || img.src)) || '' })
            out.push(o)
          }
        }
        return out
      }).catch(() => [])
      const found = rows.length ? findPeople(rows) : []
      if (found.length) add(found)
    }, 3000)
    tableTimer.unref?.()
  }

  try {
    windows.set(id, page)
    // Musaned: its window's own calls heard from the start (the HR pool's list comes as the page opens).
    if (id === 'musaned') listenMusaned(page)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    if (id === 'musaned' && deps.accountId) await (deps.musanedSignIn || musanedSignIn)(db, page, deps.accountId, (step) => set(id, { step }), check)
    // Signed in: the site says so, or else off the sign-in page and staying off it.
    const waitSignIn = async (tab) => {
      for (let t0 = Date.now(), calm = 0; ;) {
        check()
        if (tab.isClosed?.()) throw new Error('The sign-in window was closed before signing in. Press the button again.')
        if (Date.now() - t0 > SIGN_IN_WAIT) throw new Error('Nobody signed in within 15 minutes. Press the button again: it goes on from where it stopped.')
        await sleep(1500)
        if (source.token) { const t = await source.token(tab); if (t) return t; continue }
        let home = false
        try { home = new URL(tab.url()).origin === origin } catch {}
        calm = (!home || await onSignIn(tab)) ? 0 : calm + 1
        if (calm >= 2) return true
      }
    }
    const signedIn = await waitSignIn(page)
    windows.delete(id)
    if (!source.deep) await (deps.sendAway || sendAway)(page).catch(() => {})
    set(id, { status: 'copying', step: 'Reading the lists' })

    if (source.deep) {
      // The window has done its work: from here on the browser is not needed.
      clearInterval(tableTimer)
      if (!deps.page && !source.keepTab) await page.close().catch(() => {})
      await source.deep({
        progressName: `${id}-progress${deps.accountId ? '-' + deps.accountId : ''}.json`,
        db, token: signedIn, folder, check, readPerson, limit: deps.limit, download: deps.download,
        set: (patch) => set(id, patch), state: () => stateOf(id), save: (person) => saveProfile(db, id, source, person),
        // The sign-in ran out: a window for a person, then back out of sight.
        signIn: async () => {
          set(id, { status: 'signing-in', step: `${source.name} signed out. Sign in again in the window that opened: the copy goes on by itself` })
          const again = await (deps.openForPerson || openForPerson)()
          windows.set(id, again)
          try {
            await again.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
            const token = await waitSignIn(again)
            set(id, { status: 'copying', step: 'Going on with the copy' })
            return token
          } finally {
            windows.delete(id)
            await again.close().catch(() => {})
          }
        },
      })
      set(id, { step: 'Cutting out the CV header' })
      await takeCvHeader(db, id, source)
      set(id, { status: 'done', step: '' })
      return
    }

    // Every list page, those with people first.
    const queue = (source.start || []).map(p => new URL(p, origin).href)
    const seen = new Set()
    const pick = () => queue.sort((a, b) => PEOPLE.test(b) - PEOPLE.test(a)).shift()
    const cvPages = []
    const notFound = []   // pages the site said do not exist (404)
    const take = async () => {
      for (const l of await links(page)) {
        const u = new URL(l)
        if (u.origin !== origin) continue
        if (source.only && !source.only.test(u.pathname)) continue
        if (/\/(cv|print)\b/i.test(u.pathname) && cvPages.length < MAX_TEMPLATES) cvPages.push(u.href)
        if (!AVOID.test(u.pathname) && !hasId(u.pathname) && !seen.has(u.href) && !queue.includes(u.href)) queue.push(u.href)
      }
    }
    await take()
    while (queue.length && seen.size < MAX_PAGES) {
      check()
      const at = pick()
      seen.add(at)
      set(id, { step: `Reading ${new URL(at).pathname}` })
      await page.goto(at, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {})
      if (await page.evaluate(() => /\b404\b|could not be found|page not found/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 600))).catch(() => false)) notFound.push(new URL(at).pathname)
      if (await onSignIn(page)) throw new Error('The site signed out. Press the button again')
      add(findPeople(await readTables(page)))
      await take()
      // A list with no paging in its address: its own Next button.
      for (let i = 0, before = -1; i < 500 && people.size !== before; i++) {
        before = people.size
        check()
        if (!(await pressNext(page))) break
        await sleep(1500)
        add(findPeople(await readTables(page)))
      }
    }

    // Each list to its last page.
    let requests = 0
    for (const [first, l] of lists) {
      let at = first, json = l.json, count = l.count
      for (;;) {
        check()
        const next = nextPage(at, json, count)
        if (!next || next === at || ++requests > MAX_REQUESTS) break
        set(id, { step: `Reading every page: ${people.size} so far` })
        const got = await ask(page, next, l.headers, false, l.method === 'POST' ? { method: 'POST', body: l.body } : {})
        try { json = JSON.parse(got?.text) } catch { break }
        const found = findPeople(json)
        const before = people.size
        add(found)
        if (!found.length || people.size === before) break
        at = next; count = found.length
        await sleep(120)
      }
    }

    for (const l of brokerLists.values()) {
      let at = l.url, json = l.json, count = l.count
      for (let i = 0; i < 200; i++) {
        check()
        const total = Number(json?.data?.total ?? json?.total ?? 0)
        const u = new URL(at)
        const pg = Number(u.searchParams.get('page') || json?.data?.page || 1)
        if (!total || pg * count >= total) break
        u.searchParams.set('page', String(pg + 1))
        if (!u.searchParams.has('pageSize') && count) u.searchParams.set('pageSize', String(count))
        const got = await ask(page, u.href, l.headers)
        try { json = JSON.parse(got?.text) } catch { break }
        const before = brokersFound.size
        collectBrokers(json, u.href, brokersFound)
        if (brokersFound.size === before) break
        at = u.href
      }
    }
    set(id, { step: `Brokers found: ${brokersFound.size}` })
    const brokerOf = new Map()   // the site's broker id → Adal Keep broker id
    if (brokersFound.size && !deps.limit) {
      set(id, { step: `Making the brokers: ${brokersFound.size}` })
      const b = await saveBrokers(db, [], brokersFound, source.name)
      set(id, { brokers: b.created + b.filled })
      console.log(`[transition ${id}] brokers first: ${b.created} new, ${b.filled} filled`)
    }
    for (const r of await db('brokers').where('notes', 'like', `${source.name} broker %`).select('id', 'notes').catch(() => [])) {
      const m = String(r.notes).split('\n')[0].match(/ broker (.+)$/)
      if (m) brokerOf.set(m[1], r.id)
    }

    // Lists are often short: her own record says more, when the site has one.
    const [base, firstList] = [...lists.entries()][0] || []
    if (base) {
      const stem = base.replace(/[?#].*/, '').replace(/\/$/, '')
      let works = 0, tried = 0
      for (const p of people.values()) {
        check()
        if (deps.limit && tried >= deps.limit) break
        const rid = p.raw.id ?? p.raw._id ?? p.raw.uuid
        if (rid == null || (tried >= 3 && !works)) continue
        tried++
        const got = await ask(page, `${stem}/${rid}`, firstList.headers)
        let json = null
        try { json = JSON.parse(got?.text) } catch {}
        const more = json && findPeople(json).find(f => f.person.passport_number === p.person.passport_number)
        if (!more) continue
        works++
        p.person = { ...more.person, ...p.person }
        p.raw = { ...p.raw, ...more.raw }
        set(id, { step: `Reading each person: ${works} of ${people.size}` })
        await sleep(80)
      }
    }
    if (!people.size && notFound.length) throw new Error(`${source.name} says “page not found” (404) for ${notFound.join(', ')} at ${origin}. Check the address is your agency's own (like https://NAME.agency.pextran.com/) and that this account can open Recruits.`)
    fs.writeFileSync(path.join(folder, 'people.json'), JSON.stringify([...people.values()].map(p => p.raw), null, 1))

    // Into Adal Keep.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-transition-'))
    const cvFiles = []
    try {
      let n = 0
      const saved = []
      for (const { person, raw } of people.values()) {
        check()
        if (deps.limit && n >= deps.limit) break
        set(id, { step: `Saving ${++n} of ${people.size}: ${person.full_name}`, saved: n })
        const profileId = await saveProfile(db, id, source, person)
        const myBroker = brokerOf.get(String(raw.brokerId ?? raw.broker_id ?? raw.data?.brokerId ?? ''))
        if (myBroker) await db('profiles').where('id', profileId).where(q => q.whereNull('broker_id').orWhere('broker_id', 0)).update({ broker_id: myBroker }).catch(() => {})
        saved.push({ person, raw, profileId })
        const wanted = [...filesOf(raw, origin), ...(source.files?.(raw, origin) || [])]
        for (const f of wanted) {
          const headers = firstList?.headers || {}
          let got = await ask(page, f.url, headers, true)
          if (!got?.base64 && /^https:/.test(f.url)) {
            try {
              const r = await fetch(f.url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) got = { base64: Buffer.from(await r.arrayBuffer()).toString('base64'), type: r.headers.get('content-type') || '' }
            } catch {}
          }
          if (got?.base64 && /octet/i.test(got.type)) got.type = /\.pdf(\?|$)/i.test(f.url) ? 'application/pdf' : /\.png(\?|$)/i.test(f.url) ? 'image/png' : 'image/jpeg'
          if (!got?.base64 || !/image|pdf|octet/i.test(got.type)) continue
          const ext = /pdf/i.test(got.type) ? '.pdf' : /png/i.test(got.type) ? '.png' : /webp/i.test(got.type) ? '.webp' : '.jpg'
          const file = path.join(tmp, `${person.passport_number}-${f.field}${ext}`.replace(/\s/g, '_'))
          fs.writeFileSync(file, Buffer.from(got.base64, 'base64'))
          if (await saveOnProfile(db, profileId, f.field, file, path.basename(file))) set(id, { files: stateOf(id).files + 1 })
          if (f.field === 'CV' && ext === '.pdf' && cvFiles.length < MAX_TEMPLATES) {
            const keep = path.join(tmp, `cv-${cvFiles.length}.pdf`)
            fs.copyFileSync(file, keep)
            cvFiles.push(keep)
          }
        }
      }
      if (brokersFound.size) {
        set(id, { step: 'Making the brokers' })
        // A trial move: only the brokers of the girls it saved.
        const found = deps.limit ? new Map([...brokersFound].map(([k, v]) => [k, { ...v, __fromBrokerList: false }])) : brokersFound
        const b = await saveBrokers(db, saved, found, source.name)
        set(id, { brokers: b.created + b.filled })
        console.log(`[transition ${id}] brokers: ${b.created} new, ${b.filled} filled, ${b.assigned} people given theirs`)
      }
      // The agency's CV header (not its template): cut out and kept for "Add CV template".
      set(id, { step: 'Cutting out the CV header' })
      await takeCvHeader(db, id, source)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    set(id, { status: 'done', step: '' })
  } finally {
    page.off('response', onResponse)
    windows.delete(id)
    if (!deps.page) await page.close().catch(() => {})
  }
}

/**
 * The CVs this system's people came with: the header they all share is cut
 * out and kept (Add CV template offers it). A person then picks the colours.
 */
async function takeCvHeader(db, id, source) {
  try {
    const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .join('profiles', 'profiles.id', 'profile_fields.profile_id')
      .where('profile_fields.name', 'CV').where('profiles.created_by', `Transition: ${source.name}`)
      .where(q => q.where('files.mimetype', 'like', 'image/%').orWhere('files.path', 'like', '%.jpg').orWhere('files.path', 'like', '%.png'))
      .orderBy('files.id', 'desc').limit(8).select('files.path')
    const { SAFE_STORAGE_DIR } = await import('./docPipeline.js')
    const files = rows.map(r => path.join(SAFE_STORAGE_DIR, path.basename(r.path)))
    if (!(await import('./plans.js')).hasFeature('cv_header')) return
    const got = await (await import('./cvHeader.js')).harvestHeaders(db, files, source.name, SAFE_STORAGE_DIR)
    if (got) { set(id, { templates: (stateOf(id).templates || 0) + 1 }); console.log(`[transition ${id}] CV header kept (#${got})`) }
  } catch (e) { console.warn(`[transition ${id}] CV header:`, e.message) }
}

// One person is saved at a time, so two copies of the same passport (EasyEnjaz
// lists some people as active and inactive) never make two profiles.
let saving = Promise.resolve()
function saveProfile(db, id, source, person) {
  const next = saving.then(() => saveOne(db, id, source, person))
  saving = next.catch(() => {})
  return next
}

/** The same passport however it was typed: no spaces, dashes or dots. */
const SAME_PASSPORT = "UPPER(REPLACE(REPLACE(REPLACE(passport_number, ' ', ''), '-', ''), '.', '')) = ?"
export const passportKey = (p) => String(p || '').toUpperCase().replace(/[\s.-]/g, '')

async function saveOne(db, id, source, person) {
  const now = new Date().toISOString()
  const cols = await db('profiles').columnInfo()
  const row = Object.fromEntries(Object.entries(person).filter(([k, v]) => cols[k] && v !== ''))
  const had = await db('profiles').whereRaw(SAME_PASSPORT, [passportKey(person.passport_number)]).orderBy('id').first()
  if (!had) {
    const [newId] = await db('profiles').insert({ ...row, created_by: `Transition: ${source.name}`, created_at: now, updated_at: now })
    set(id, { created: stateOf(id).created + 1 })
    return newId
  }
  // What was typed here stays.
  const empty = Object.fromEntries(Object.entries(row).filter(([k]) => had[k] == null || had[k] === ''))
  if (Object.keys(empty).length) {
    await db('profiles').where('id', had.id).update({ ...empty, updated_at: now })
    set(id, { updated: stateOf(id).updated + 1 })
  }
  return had.id
}

/** A template the site keeps as HTML. */
function templatesIn(json, out = [], depth = 0) {
  if (!json || typeof json !== 'object' || depth > 5) return out
  for (const v of Array.isArray(json) ? json : Object.values(json)) {
    if (typeof v === 'string' && v.length > 300 && /<(table|div)\b/i.test(v) && !Array.isArray(json)) out.push({ name: json.name || json.title || 'Template', html: v })
    else templatesIn(v, out, depth + 1)
  }
  return out
}

async function copyTemplates(db, id, source, page, { htmlTemplates, cvPages, cvFiles, tmp, passports, check }) {
  const { ingestTemplate } = await import('./cvTemplateIngest.js')
  const jobs = cvFiles.map((f, i) => ({ file: f, name: `${source.name} CV ${i + 1}.pdf`, mime: 'application/pdf' }))
  // A CV page counts only when it really shows a person's CV.
  for (const [i, url] of cvPages.entries()) {
    check()
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {})
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    if (!passports.some(p => text.toUpperCase().includes(p))) continue
    const file = path.join(tmp, `cv-page-${i}.png`)
    await page.screenshot({ path: file, fullPage: true })
    jobs.push({ file, name: `${source.name} CV page ${i + 1}.png`, mime: 'image/png' })
  }
  for (const [i, t] of htmlTemplates.slice(0, MAX_TEMPLATES).entries()) {
    check()
    await page.setContent(t.html, { waitUntil: 'load', timeout: 30000 }).catch(() => {})
    const file = path.join(tmp, `template-${i}.png`)
    await page.screenshot({ path: file, fullPage: true })
    jobs.push({ file, name: `${t.name}.png`, mime: 'image/png' })
  }
  for (const j of jobs.slice(0, MAX_TEMPLATES)) {
    check()
    try {
      const meta = await ingestTemplate(j.file, j.name, j.mime)
      if (await db('cv_templates').where('name', meta.name).first()) continue
      const now = new Date().toISOString()
      await db('cv_templates').insert({
        name: meta.name, agency_name: meta.agency_name, agency_name_ar: meta.agency_name_ar, salary: meta.salary || null,
        currency: meta.currency, country: meta.country, contract_years: meta.contract_years, html_content: meta.html_content,
        css_content: meta.css_content, placeholders: meta.placeholders, source_file: `Transition: ${j.name}`, is_active: true, include_passport: true, passport_h1: 'Passport', passport_include_header: true, created_at: now, updated_at: now,
      })
      set(id, { templates: stateOf(id).templates + 1 })
    } catch (e) {
      console.warn(`[transition ${id}] template ${j.name}:`, e.message)
      set(id, { skipped: stateOf(id).skipped + 1 })
    }
  }
}
