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
import { copyEasyEnjaz } from './easyEnjazCopy.js'

export const SOURCES = {
  // Its API is known, so it is asked directly: see easyEnjazCopy.js.
  easyenjaz: { name: 'EasyEnjaz', url: 'https://easyenjaz.com/', deep: copyEasyEnjaz },
  enjazplus: { name: 'EnjazPlus', url: 'https://v2.enjazplus.com/' },
  musaned: {
    name: 'Musaned', url: 'https://tawtheeq.musaned.com.sa/', start: ['/hr-pool'],
    // Her pictures are not in her record: Musaned serves them by her id.
    files: (r, origin) => r.id ? [
      { field: 'Passport', url: `${origin}/api/hrpool/${r.id}/photo/PASSPORT` },
      { field: 'Photo', url: `${origin}/api/hrpool/${r.id}/photo/PERSONAL` },
    ] : [],
  },
  pextran: { name: 'Pextran', url: null },
}

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'transitions')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const SIGN_IN_WAIT = 15 * 60_000
const MAX_PAGES = 40, MAX_REQUESTS = 3000, MAX_TEMPLATES = 5

const states = new Map()
const blank = () => ({ status: 'idle', step: '', people: 0, created: 0, updated: 0, files: 0, templates: 0, skipped: 0, failed: 0, error: null, folder: null })
const stateOf = (id) => states.get(id) || blank()
const set = (id, patch) => { states.set(id, { ...stateOf(id), ...patch }); return states.get(id) }

export const transitionStates = () => Object.fromEntries(Object.entries(SOURCES).map(([id, s]) => {
  const { stop, ...st } = stateOf(id)
  return [id, { ...st, name: s.name }]
}))

export function stopTransition(id) {
  if (['signing-in', 'copying'].includes(stateOf(id).status)) set(id, { stop: true, step: 'Stopping…' })
}

/** A Pextran address: only https on pextran.com, reduced to the site itself. */
export function checkLink(link) {
  let u
  try { u = new URL(/^https?:\/\//i.test(String(link || '').trim()) ? String(link).trim() : `https://${String(link || '').trim()}`) }
  catch { throw new Error('Paste the Pextran address, for example https://zadulmead.agency.pextran.com/') }
  if (!/(^|\.)pextran\.com$/i.test(u.hostname)) throw new Error('That is not a Pextran address (it ends in pextran.com)')
  return `https://${u.hostname}/`
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
  passport_expiry_date: ['passportexpirydate', 'passportexpiry', 'dateofexpiry', 'expirydate', 'expirationdate'],
  children_count: ['childrencount', 'numberofchildren', 'noofchildren', 'children'],
  weight: ['weight'], height: ['height'], complexion: ['complexion'],
  education_level: ['educationlevel', 'education'],
  job_title: ['jobtitle', 'job', 'profession', 'occupation'],
  salary: ['salary', 'monthlysalary'],
  mother_name: ['mothername'], father_name: ['fathername'], spouse_name: ['spousename'],
  region: ['region'], living_town: ['livingtown', 'city'],
  labor_id: ['laborid', 'labourid'],
  visa_number: ['visanumber', 'visano'],
  contract_number: ['contractnumber', 'contractno'],
  employer_name: ['employername', 'sponsorname'],
  emergency_name: ['emergencyname', 'emergencycontactname'],
  emergency_phone: ['emergencyphone', 'emergencycontactphone'],
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
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 1 && !plain(v)) deeper.push([k, v])
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
  const p = readPerson(json)
  if (p) { out.push({ person: p, raw: json }); return out }
  for (const v of Object.values(json)) findPeople(v, out, depth + 1)
  return out
}

const FIELD_OF = [
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
  return seen || /\/(login|log-in|signin|sign-in|auth|realms)(\/|\?|$)/i.test(location.pathname)
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
  return [...t.querySelectorAll('tbody tr')].map(r => Object.fromEntries([...r.cells].map((c, i) => [heads[i] || `c${i}`, c.innerText.trim()])))
})).catch(() => [])

const links = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href))]).catch(() => [])
const AVOID = /log.?out|sign.?out|delete|remove|destroy|edit|create|\/new|\/add|settings|billing|payment/i
const PEOPLE = /candidat|worker|cv|employee|applicant|maid|hr-pool|recruit|labou?r|people|profile|template/i
const hasId = (p) => /\/(\d+|[0-9a-f]{16,}|[0-9a-f-]{32,})(\/|$)/i.test(p)

const pressNext = (page) => page.evaluate(() => {
  const seen = (e) => e.offsetParent !== null && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(e.className + (e.parentElement?.className || ''))
  const b = [...document.querySelectorAll('a[rel="next"], [aria-label*="next" i], li.next a, .pagination a, .pagination button, nav button')]
    .filter(seen).find(e => e.rel === 'next' || /next/i.test(e.getAttribute('aria-label') || '') || /^(next|›|»|>)$/i.test(e.innerText.trim()) || e.parentElement?.className?.includes?.('next'))
  if (!b) return false
  b.click()
  return true
}).catch(() => false)

// ── The copy ────────────────────────────────────────────────────────────────
export function startTransition(db, id, link, deps = {}) {
  const source = deps.source || SOURCES[id]
  if (!source) throw new Error('Unknown system')
  if (['signing-in', 'copying'].includes(stateOf(id).status)) return stateOf(id)
  const url = link || source.url
  if (!url) throw new Error('Paste the address first')
  set(id, { ...blank(), status: 'signing-in', step: `Sign in to ${source.name} in the window that opened` })
  run(db, id, source, url, deps).catch(e => {
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
  const add = (found) => {
    for (const f of found) {
      const had = people.get(f.person.passport_number)
      people.set(f.person.passport_number, had ? { person: { ...f.person, ...had.person }, raw: { ...f.raw, ...had.raw } } : f)
    }
    set(id, { people: people.size })
  }
  const onResponse = async (r) => {
    try {
      const req = r.request()
      if (!/json/i.test(r.headers()['content-type'] || '') || !['xhr', 'fetch'].includes(req.resourceType())) return
      const json = await r.json()
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
  page.on('response', onResponse)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
    // Signed in: off the sign-in page and staying off it.
    for (let t0 = Date.now(), calm = 0; calm < 2;) {
      check()
      if (Date.now() - t0 > SIGN_IN_WAIT) throw new Error('Nobody signed in within 15 minutes')
      await sleep(1500)
      calm = (await onSignIn(page)) ? 0 : calm + 1
    }
    await (deps.sendAway || sendAway)(page).catch(() => {})
    set(id, { status: 'copying', step: 'Reading the lists' })

    if (source.deep) {
      page.off('response', onResponse)
      await source.deep({
        db, page, folder, check, readPerson, limit: deps.limit, download: deps.download,
        set: (patch) => set(id, patch), state: () => stateOf(id), save: (person) => saveProfile(db, id, source, person),
      })
      set(id, { status: 'done', step: '' })
      return
    }

    // Every list page, those with people first.
    const queue = (source.start || []).map(p => new URL(p, origin).href)
    const seen = new Set()
    const pick = () => queue.sort((a, b) => PEOPLE.test(b) - PEOPLE.test(a)).shift()
    const cvPages = []
    const take = async () => {
      for (const l of await links(page)) {
        const u = new URL(l)
        if (u.origin !== origin) continue
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

    // Lists are often short: her own record says more, when the site has one.
    const [base, firstList] = [...lists.entries()][0] || []
    if (base) {
      const stem = base.replace(/[?#].*/, '').replace(/\/$/, '')
      let works = 0, tried = 0
      for (const p of people.values()) {
        check()
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
    fs.writeFileSync(path.join(folder, 'people.json'), JSON.stringify([...people.values()].map(p => p.raw), null, 1))

    // Into Adal Keep.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-transition-'))
    const cvFiles = []
    try {
      let n = 0
      for (const { person, raw } of people.values()) {
        check()
        set(id, { step: `Saving ${++n} of ${people.size}: ${person.full_name}` })
        const profileId = await saveProfile(db, id, source, person)
        const wanted = [...filesOf(raw, origin), ...(source.files?.(raw, origin) || [])]
        for (const f of wanted) {
          const headers = firstList?.headers || {}
          const got = await ask(page, f.url, headers, true)
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
      set(id, { step: 'Making the CV templates' })
      await copyTemplates(db, id, source, page, { htmlTemplates, cvPages, cvFiles, tmp, passports: [...people.keys()], check })
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    set(id, { status: 'done', step: '' })
  } finally {
    page.off('response', onResponse)
    if (!deps.page) await page.close().catch(() => {})
  }
}

async function saveProfile(db, id, source, person) {
  const now = new Date().toISOString()
  const cols = await db('profiles').columnInfo()
  const row = Object.fromEntries(Object.entries(person).filter(([k, v]) => cols[k] && v !== ''))
  const had = await db('profiles').whereRaw('UPPER(passport_number) = ?', [person.passport_number]).first()
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
        css_content: meta.css_content, placeholders: meta.placeholders, source_file: `Transition: ${j.name}`, is_active: true, created_at: now, updated_at: now,
      })
      set(id, { templates: stateOf(id).templates + 1 })
    } catch (e) {
      console.warn(`[transition ${id}] template ${j.name}:`, e.message)
      set(id, { skipped: stateOf(id).skipped + 1 })
    }
  }
}
