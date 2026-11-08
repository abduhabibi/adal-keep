/**
 * easyEnjazCopy.js — everything EasyEnjaz knows about an agency, in one visit
 * (Settings → Transitions → EasyEnjaz). A person signs in once; then, as the
 * site's own pages do, this asks its API for:
 *
 *   - every applicant, active and inactive, and each one's full record;
 *   - every file her record has a key for (photo, full body, passport, interview
 *     video, COC, medical, ID card, relative's ID, insurance, registration form);
 *   - her visa report, when she has a visa, and her CV, both as PDF;
 *   - the agency's own lists (agents, companies, templates, flights, complaints…).
 *
 * Only reads: the one POST is the site's "print CV", which makes a PDF. Every
 * record and list is kept whole in the run's folder, so a field with no column
 * here is not lost. A visit cut short goes on from where it stopped: whoever is
 * finished is noted in easyenjaz-progress.json until a whole copy has ended.
 *
 * The browser is only for signing in. The sign-in is then held here and the API
 * is asked directly, so closing that window, or Chrome, changes nothing. It lasts
 * a few hours: when it runs out the copy waits, a sign-in window comes back, and
 * it goes on. Its home page has no password box, so being signed in is asked of
 * the API. A list read only in part is never taken for the whole list.
 *
 * Checked against the real site on 2026-11-07 (list, record, a photo, visa, CV).
 * A passport scan exists only under passportKey. "Print Selected Documents → View
 * Passport" is no way round that: it prints her CV form, so it is not used.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveOnProfile } from './musanedImport.js'

const SITE = 'https://easyenjaz.com'
const WORKERS = 3
const PAGE = 100           // small enough to arrive whole on a slow line
const GIVE_UP_AFTER = 10   // people in a row with nothing from the site
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const FIELD_OF_KEY = {
  photokey: 'Photo', fullsizekey: 'Full Body Photo', passportkey: 'Passport',
  interviewkey: 'Interview Video', videokey: 'Interview Video', doc1key: 'COC Certificate',
  doc2key: 'Medical Report', idcardkey: 'ID Card', relativeidkey: 'Relative ID',
  insurancekey: 'Insurance', regformkey: 'Registration Form',
}
const LISTS = {
  'agents': '/api/Companies/Agents', 'all-agents': '/api/Companies/all_agents', 'related-agents': '/api/Companies/relatedAgents',
  'related-companies': '/api/Companies/relatedCompanies', 'active-agencies': '/api/Companies/active-agencies', 'active-companies': '/api/Companies/active-companies',
  'companies': '/api/Companies', 'company': '/api/Companies/current', 'partners': '/api/CompanyPartners', 'relations': '/api/CompanyRelations',
  'relatives': '/api/CompanyRelations/relatives', 'complaints': '/api/Complains', 'flights': '/api/Flights', 'commission-requests': '/api/commissionrequest',
  'cv-templates': '/api/CVTemplates', 'cv-preferences': '/api/CVPreferences', 'default-settings': '/api/DefaultSettings',
  'users': '/api/auth/getusers', 'roles': '/api/Auth/roles', 'statuses': '/api/applicants/distinctStatus',
}
const TYPES = [[/pdf/i, '.pdf'], [/png/i, '.png'], [/webp/i, '.webp'], [/jpe?g/i, '.jpg'], [/mp4/i, '.mp4'], [/webm/i, '.webm'], [/quicktime/i, '.mov']]

/** Sign-in secrets never go in the folder, even when a list carries them. */
export function withoutSecrets(v) {
  if (Array.isArray(v)) return v.map(withoutSecrets)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/pass(word|code)|hash|token|secret|salt/i.test(k)).map(([k, x]) => [k, withoutSecrets(x)]))
}

/** The stored file keys of a record: { field, key }. */
export function fileKeysOf(rec) {
  const out = [], seen = new Set()
  for (const [k, v] of Object.entries(rec || {})) {
    if (!/key$/i.test(k) || typeof v !== 'string' || !v.trim()) continue
    const key = /^https?:/i.test(v) ? new URL(v).pathname.slice(1) : v.trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ field: FIELD_OF_KEY[k.toLowerCase()] || 'Document', key })
  }
  return out
}

const day = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null

/** Her profile columns: what the shared reader finds, plus EasyEnjaz's own names. */
export function personOf(rec, readPerson) {
  const p = readPerson(rec)
  if (!p) return null
  const own = {
    visa_application_number: rec.applicationNo, employer_id: rec.sponsorID, employer_phone: rec.sponsorPhone, employer_address: rec.sponsorAddress,
    passport_issue_date: day(rec.pasportIssuedDate), passport_expiry_date: day(rec.pasportExpiryDate), phone_number: rec.phoneNo,
    education_level: rec.qualification, nationality: rec.currentNationality, issuing_authority: rec.placeOfIssue, zone_subcity: rec.subcity,
    emergency_name: rec.contactPerson, emergency_phone: rec.contactPhone, emergency_relationship: rec.contactKinship, notes: rec.memo,
  }
  for (const [col, v] of Object.entries(own)) if (!p[col] && v != null && String(v).trim()) p[col] = String(v).trim()
  return p
}

/** The tab's sign-in, when the site still takes it; else null. It stays out of every log and file. */
export const signedInToken = (page) => page.evaluate(async () => {
  const token = localStorage.getItem('token')
  if (!token) return null
  const r = await fetch('/api/Applicants/paged?skip=0&take=1&sortField=SNo&sortOrder=desc', { headers: { Authorization: `Bearer ${token}` } })
  return r.ok ? token : null
}).catch(() => null)

/** One read from the API. Its status 0 means no answer at all. */
async function request(token, url, { method, body, binary }) {
  try {
    const r = await fetch(SITE + url, {
      method: method || 'GET', body, signal: AbortSignal.timeout(binary ? 300_000 : 180_000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    })
    const type = r.headers.get('content-type') || ''
    if (!r.ok) return { status: r.status, type }
    return binary ? { status: r.status, type, buffer: Buffer.from(await r.arrayBuffer()) } : { status: r.status, type, text: await r.text() }
  } catch (e) { return { status: 0, error: e.message } }
}

export async function copyEasyEnjaz({ db, token, folder, set, state, check, readPerson, save, signIn, ask = request, download = fetch, limit = Infinity, wait = sleep }) {
  // All the workers wait for one sign-in.
  let renewing = null
  const renew = (old) => {
    if (token !== old) return token
    renewing ||= signIn().then(t => { token = t; return t }).finally(() => { renewing = null })
    return renewing
  }
  const call = async (url, opts = {}) => {
    for (let tries = 0, signIns = 0; ;) {
      check()
      const used = token
      const r = await ask(used, url, opts)
      if (r.status === 401 && signIns++ < 2) { await renew(used); continue }
      if (tries++ < 4 && (r.status === 0 || r.status === 429 || r.status >= 500)) { await wait(4000 * tries); continue }
      return r
    }
  }
  const json = async (url) => {
    const r = await call(url)
    if (r.status !== 200 || !/json/i.test(r.type || '')) return null
    try { return JSON.parse(r.text) } catch { return null }
  }

  // Everyone, active and inactive.
  set({ status: 'copying', step: 'Reading the list of applicants' })
  const rows = []
  for (const list of ['/api/Applicants/paged', '/api/Applicants/inactive_paged']) {
    for (let skip = 0; ;) {
      check()
      const j = await json(`${list}?skip=${skip}&take=${PAGE}&sortField=SNo&sortOrder=desc`)
      if (!j) throw new Error('EasyEnjaz did not give the whole list: check the internet and press the button again. It goes on from where it stopped.')
      const got = j.data || []
      rows.push(...got)
      skip += PAGE
      set({ step: `Reading the list of applicants: ${rows.length}` })
      if (!got.length || skip >= Number(j.totalCount || 0)) break
    }
  }
  if (!rows.length) throw new Error('EasyEnjaz gave no applicants. Are you signed in with an agency account?')

  // The agency's own lists.
  const agencyDir = path.join(folder, 'agency')
  fs.mkdirSync(agencyDir, { recursive: true })
  for (const [name, url] of Object.entries(LISTS)) {
    check()
    set({ step: `Reading the agency's ${name.replace(/-/g, ' ')}` })
    const j = await json(url)
    if (j != null) fs.writeFileSync(path.join(agencyDir, `${name}.json`), JSON.stringify(withoutSecrets(j), null, 1))
  }

  // Each person, going on from an earlier visit.
  const records = path.join(folder, 'records')
  fs.mkdirSync(records, { recursive: true })
  const progressFile = path.join(path.dirname(folder), 'easyenjaz-progress.json')
  let done = new Set()
  try { done = new Set(JSON.parse(fs.readFileSync(progressFile, 'utf8'))) } catch {}
  const todo = rows.filter(r => !done.has(String(r.id))).slice(0, limit)
  const total = rows.length
  set({ people: total })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-easyenjaz-'))
  const failed = () => set({ failed: (state().failed || 0) + 1 })

  const keep = async (profileId, passport, field, label, buf, ext) => {
    const name = `${passport}-${label}${ext}`.replace(/[^\w.-]+/g, '_')
    const file = path.join(tmp, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`)
    fs.writeFileSync(file, buf)
    try { if (await saveOnProfile(db, profileId, field, file, name)) set({ files: (state().files || 0) + 1 }) }
    finally { fs.rmSync(file, { force: true }) }
  }

  const fileOf = async (key) => {
    for (const route of ['file-url', 'public-url']) {
      const j = await json(`/api/applicants/${route}?fileKey=${encodeURIComponent(key)}`)
      if (!j?.url) continue
      const r = await download(j.url).catch(() => null)
      if (!r?.ok) continue
      const type = r.headers.get('content-type') || ''
      const ext = TYPES.find(([re]) => re.test(type))?.[1] || TYPES.find(([re]) => re.test(key))?.[1] || path.extname(key).toLowerCase() || '.jpg'
      return { buf: Buffer.from(await r.arrayBuffer()), ext }
    }
    return null
  }

  // A report is new bytes each time, so its name says whether she has it.
  const hasFile = (profileId, name) => db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where({ 'profile_fields.profile_id': profileId, 'files.original_name': name }).first()

  const report = async (profileId, passport, field, label, url, opts = {}) => {
    if (await hasFile(profileId, `${passport}-${label}.pdf`)) return true
    const r = await call(url, { ...opts, binary: true })
    if (r.status !== 200 || !/pdf/i.test(r.type || '') || !r.buffer?.length) {
      failed()
      return false
    }
    await keep(profileId, passport, field, label, r.buffer, '.pdf')
    return true
  }

  const copyOne = async (row) => {
    const id = String(row.id)
    const rec = { ...row }
    const full = await json(`/api/applicants/${id}`)
    if (!full) { failed(); return 'none' } // Nothing is taken from a half answer: she stays for the next try.
    for (const [k, v] of Object.entries(full)) if (v != null && v !== '') rec[k] = v
    fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify(withoutSecrets(rec), null, 1))
    const person = personOf(rec, readPerson)
    if (!person) return 'whole' // No passport number: her record is kept in the folder.
    const profileId = await save(person)
    let whole = true
    for (const { field, key } of fileKeysOf(rec)) {
      check()
      const got = await fileOf(key)
      if (got) await keep(profileId, person.passport_number, field, field.replace(/\s/g, '-'), got.buf, got.ext)
      else { failed(); whole = false }
    }
    if (rec.visaNo) whole = (await report(profileId, person.passport_number, 'Visa', 'EasyEnjaz-Visa', `/api/Reports/applicant_visa/${id}`)) && whole
    whole = (await report(profileId, person.passport_number, 'CV', 'EasyEnjaz-CV', '/api/Reports/print_cv/CVReport.repx', { method: 'POST', body: JSON.stringify([row.id]) })) && whole
    return whole ? 'whole' : 'part'
  }

  // A file EasyEnjaz itself no longer has is not a lost line: after two visits
  // that person counts as done, so a copy never stops on the same people again.
  const triesFile = path.join(path.dirname(folder), 'easyenjaz-tries.json')
  let tries = {}
  try { tries = JSON.parse(fs.readFileSync(triesFile, 'utf8')) } catch {}
  const siteAnswers = async () => !!(await json(`/api/Applicants/paged?skip=0&take=1&sortField=SNo&sortOrder=desc`))
  let at = 0, finished = rows.length - todo.length, stopped = null, silent = 0
  const worker = async () => {
    while (!stopped) {
      const row = todo[at++]
      if (!row) return
      try {
        check()
        const got = await copyOne(row)
        finished++
        const id = String(row.id)
        if (got !== 'none') silent = 0
        if (got === 'part') { tries[id] = (tries[id] || 0) + 1; fs.writeFileSync(triesFile, JSON.stringify(tries)) }
        if (got === 'whole' || (got === 'part' && tries[id] >= 2)) {
          done.add(id)
          fs.writeFileSync(progressFile, JSON.stringify([...done]))
        } else if (got === 'none' && ++silent >= GIVE_UP_AFTER && !(await siteAnswers().then(ok => { if (ok) silent = 0; return ok }))) {
          throw new Error(`EasyEnjaz stopped answering after ${finished} of ${total}: check the internet and press the button again. It goes on from where it stopped.`)
        }
        set({ step: `Copying everyone: ${finished} of ${total}` })
      } catch (e) {
        stopped ||= e
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  if (stopped) throw stopped

  // A whole copy is over: the next one looks at everyone again.
  if (done.size >= rows.length) { fs.rmSync(progressFile, { force: true }); fs.rmSync(triesFile, { force: true }) }
}
