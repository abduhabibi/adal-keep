/**
 * EnjazPlus (v2.enjazplus.com) — everything in one visit.
 *
 * Its pages read their data from one GraphQL address (/graphql). Once the
 * person has signed in in the window, the sign-in (its cookies, and the token
 * the page keeps, if any) is taken and the copy talks to /graphql directly:
 * every employee of every tab (Pending, Available, Selected, Contracted,
 * Embassy, …), page by page, each with all her details and every file
 * (photos, passport, medical, COC, visa, contract, ticket, video…).
 * It goes on from where a visit stopped; signed out midway → the window opens
 * again for the person and the copy goes on.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveOnProfile } from './musanedImport.js'
import { EMPLOYEE_FIELDS } from './enjazPlusFields.js'

const SITE = 'https://v2.enjazplus.com'
const PAGE = 50
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// EnjazPlus's file fields → Adal Keep's document fields.
const FILES = {
  facePhoto: 'Photo', standPhoto: 'Full Body Photo', passportScan: 'Passport', medicalPhoto: 'Medical Report',
  cocCertificateScan: 'COC Certificate', insuranceScan: 'Insurance', workingVisaScan: 'Visa', employmentContractScan: 'Contract',
  flightTicketScan: 'Ticket', originalIdScan: 'ID Card', emergencyContactIdScan: 'Relative ID', educationCertificateScan: 'Education Certificate',
  fingerPrintScan: 'Fingerprint', employeeVideo: 'Interview Video',
}
const TYPES = [[/pdf/i, '.pdf'], [/png/i, '.png'], [/webp/i, '.webp'], [/jpe?g/i, '.jpg'], [/mp4/i, '.mp4'], [/webm/i, '.webm'], [/quicktime/i, '.mov']]
const LIST = `query AdalEmployees($skip: Int!, $take: Int!) { employees(skip: $skip, take: $take) { totalCount employees { ...getEmployeeOnly } } } ${EMPLOYEE_FIELDS}`

/** One GraphQL call with the signed-in person's credentials. */
async function gql(cred, query, variables = {}, ask = fetch) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Origin: SITE, Referer: `${SITE}/app/employees` }
  if (cred?.cookie) headers.Cookie = cred.cookie
  if (cred?.auth) headers.Authorization = cred.auth
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 180_000)
  try {
    const r = await ask(`${SITE}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: ctl.signal })
    const j = await r.json().catch(() => null)
    return { status: r.status, data: j?.data, error: j?.errors?.[0]?.message || (r.ok ? null : `HTTP ${r.status}`) }
  } catch (e) {
    return { status: 0, error: e.message }
  } finally { clearTimeout(t) }
}
const signedOut = (r) => r.status === 401 || /not ?authori[sz]ed|unauthenticated|jwt|log ?in|session/i.test(r.error || '')

/**
 * The window's sign-in, once it works: { cookie, auth } — or null while the
 * person is still signing in.
 */
export async function signedInEnjazPlus(page, ask = fetch) {
  const cookies = await page.cookies(SITE).catch(() => [])
  const info = await page.evaluate(() => localStorage.getItem('userInfo')).catch(() => null)
  if (!info && !cookies.length) return null
  let token = null
  try { const u = JSON.parse(info || 'null'); token = u?.token || u?.accessToken || u?.jwt || u?.data?.token || null } catch {}
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  // The way the site takes it: cookies alone, or with its token.
  for (const auth of [null, token && `Bearer ${token}`, token].filter((x, i) => i === 0 || x)) {
    const cred = { cookie, auth }
    const r = await gql(cred, 'query { employees(skip: 0, take: 1) { totalCount } }', {}, ask)
    if (r.data?.employees) return cred
  }
  return null
}

const day = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null
const words = (v) => String(v || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim()

/** Her profile columns from an EnjazPlus employee. */
export function personOf(e, readPerson) {
  const a = e.additionalData || {}, ad = e.address || {}
  const flat = { ...e, ...a, ...ad, fullName: [e.givenName, e.surName].filter(Boolean).join(' ') }
  const p = readPerson(flat) || {}
  const passport = String(e.passportNumber || p.passport_number || '').toUpperCase().replace(/\s/g, '')
  const name = flat.fullName || p.full_name
  if (!passport || !name) return null
  return {
    ...p,
    full_name: name, passport_number: passport,
    ...(a.labourId ? { labor_id: String(a.labourId).toUpperCase().trim() } : {}),
    ...(ad.telephone ? { phone_number: ad.telephone } : {}),
    ...(day(e.dateOfBirth) ? { date_of_birth: day(e.dateOfBirth) } : {}),
    ...(day(e.passportIssueDate) ? { passport_issue_date: day(e.passportIssueDate) } : {}),
    ...(day(e.passportExpiryDate) ? { passport_expiry_date: day(e.passportExpiryDate) } : {}),
    ...(a.appliedCountry ? { destination_country: words(a.appliedCountry) } : {}),
    ...(a.religion ? { religion: words(a.religion) } : {}),
    ...(a.maritalStatus ? { marital_status: words(a.maritalStatus) } : {}),
    ...(e.placeOfBirth ? { place_of_birth: e.placeOfBirth } : {}),
  }
}

export async function copyEnjazPlus({ db, token, folder, set, state, check, readPerson, save, signIn, ask = fetch, download = fetch, limit = Infinity, wait = sleep }) {
  let cred = token
  const call = async (query, variables) => {
    for (let tries = 0, signIns = 0; ;) {
      check()
      const r = await gql(cred, query, variables, ask)
      if (r.data) return r.data
      if (signedOut(r) && signIns++ < 2) { cred = await signIn(); continue }
      if (tries++ < 4 && (r.status === 0 || r.status === 429 || r.status >= 500)) { await wait(4000 * tries); continue }
      throw new Error(`EnjazPlus did not answer: ${r.error || 'no data'}. Check the internet and press the button again — it goes on from where it stopped.`)
    }
  }

  // Everyone, in every tab.
  set({ status: 'copying', step: 'Reading the list of employees' })
  const all = []
  for (let skip = 0; ;) {
    const d = await call(LIST, { skip, take: PAGE })
    const got = d.employees?.employees || []
    all.push(...got)
    skip += PAGE
    set({ step: `Reading the list of employees: ${all.length} of ${d.employees?.totalCount ?? '?'}` })
    if (!got.length || skip >= Number(d.employees?.totalCount || 0)) break
  }
  if (!all.length) throw new Error('EnjazPlus gave no employees. Are you signed in with the agency\'s account?')

  const records = path.join(folder, 'records')
  fs.mkdirSync(records, { recursive: true })
  // What each one has and what is done (her text, each file): a move that
  // stopped goes on from there and fetches only what is left.
  const progressFile = path.join(path.dirname(folder), 'enjazplus-progress.json')
  let ledger = {}
  try { const old = JSON.parse(fs.readFileSync(progressFile, 'utf8')); ledger = Array.isArray(old) ? Object.fromEntries(old.map(k => [k, { text: true, all: true, done: [] }])) : old } catch {}
  const note = (e) => (ledger[String(e._id)] ||= { text: false, all: false, done: [] })
  let saveTimer = null
  const keep = (now) => { clearTimeout(saveTimer); const w = () => { try { fs.writeFileSync(progressFile, JSON.stringify(ledger)) } catch {} }; if (now) w(); else saveTimer = setTimeout(w, 2000) }
  // The newest first (as EnjazPlus dates them), then as its list gave them.
  const when = (e) => Date.parse(e.createdAt || e.created_at || e.updatedAt || '') || 0
  const order = all.map((e, i) => ({ e, i })).sort((x, y) => (when(y.e) - when(x.e)) || (x.i - y.i)).map(x => x.e)
    .filter(e => !note(e).all).slice(0, limit)
  set({ people: all.length })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-enjazplus-'))
  const profileOf = new Map()
  try {
    // 1. Everyone's text: her profile, at once.
    let n = 0
    for (const e of order) {
      check()
      fs.writeFileSync(path.join(records, `${e._id}.json`), JSON.stringify(e, null, 1))
      const person = personOf(e, readPerson)
      if (!person) { note(e).all = true; continue }
      profileOf.set(String(e._id), { id: await save(person), person })
      note(e).text = true
      set({ step: `Making the profiles: ${++n} of ${order.length}` })
    }
    keep(true)
    // 2. Her files: everyone's face and full body photos, then everyone's
    // passport, then the rest — 4 at a time, each tried 3 times on a slow line.
    // The visa is made in Adal Keep: not copied.
    const TIERS = [['facePhoto', 'standPhoto'], ['passportScan'], Object.keys(FILES).filter(k => !['facePhoto', 'standPhoto', 'passportScan', 'workingVisaScan'].includes(k))]
    const fetchOne = async (e, key) => {
      const url = e[key], field = FILES[key], who = profileOf.get(String(e._id))
      if (!who || typeof url !== 'string' || !/^https?:|^\//.test(url) || note(e).done.includes(key)) return
      const abs = url.startsWith('/') ? SITE + url : url
      let r = null
      for (let i = 0; i < 3; i++) {
        check()
        r = await download(abs, { headers: new URL(abs).host === new URL(SITE).host && cred?.cookie ? { Cookie: cred.cookie } : {}, signal: AbortSignal.timeout(120000) }).catch(() => null)
        if (r?.ok || (r && r.status !== 429 && r.status < 500)) break
        if (i < 2) await wait(i ? 6000 : 2000)
      }
      if (!r?.ok) { set({ failed: (state().failed || 0) + 1 }); return }
      const type = r.headers.get('content-type') || ''
      const ext = TYPES.find(([re]) => re.test(type))?.[1] || TYPES.find(([re]) => re.test(abs))?.[1] || '.jpg'
      const name = `${who.person.passport_number}-EnjazPlus-${field.replace(/\s/g, '-')}${ext}`
      const file = path.join(tmp, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`)
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
      try { if (await saveOnProfile(db, who.id, field, file, name)) set({ files: (state().files || 0) + 1 }) }
      finally { fs.rmSync(file, { force: true }) }
      note(e).done.push(key); keep()
    }
    for (const [t, keys] of TIERS.entries()) {
      let i = 0, k = 0
      const next = () => order[i++]
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let e; (e = next());) {
          for (const key of keys) await fetchOne(e, key)
          set({ step: `Files (${['face and full body photos', 'passports', 'other documents'][t]}): ${++k} of ${order.length}` })
        }
      }))
    }
    for (const e of order) if (note(e).text) note(e).all = true
  } finally { keep(true); fs.rmSync(tmp, { recursive: true, force: true }) }
  const done = new Set(Object.entries(ledger).filter(([, v]) => v.all).map(([k]) => k))
  if (done.size >= all.length) fs.rmSync(progressFile, { force: true })
}
