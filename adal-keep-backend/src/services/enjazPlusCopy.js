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
  const progressFile = path.join(path.dirname(folder), 'enjazplus-progress.json')
  let done = new Set()
  try { done = new Set(JSON.parse(fs.readFileSync(progressFile, 'utf8'))) } catch {}
  const todo = all.filter(e => !done.has(String(e._id))).slice(0, limit)
  set({ people: all.length })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-enjazplus-'))
  let finished = all.length - todo.length
  try {
    for (const e of todo) {
      check()
      fs.writeFileSync(path.join(records, `${e._id}.json`), JSON.stringify(e, null, 1))
      const person = personOf(e, readPerson)
      if (person) {
        const profileId = await save(person)
        for (const [key, field] of Object.entries(FILES)) {
          const url = e[key]
          if (typeof url !== 'string' || !/^https?:|^\//.test(url)) continue
          check()
          const abs = url.startsWith('/') ? SITE + url : url
          const r = await download(abs, { headers: new URL(abs).host === new URL(SITE).host && cred?.cookie ? { Cookie: cred.cookie } : {} }).catch(() => null)
          if (!r?.ok) { set({ failed: (state().failed || 0) + 1 }); continue }
          const type = r.headers.get('content-type') || ''
          const ext = TYPES.find(([re]) => re.test(type))?.[1] || TYPES.find(([re]) => re.test(abs))?.[1] || '.jpg'
          const name = `${person.passport_number}-EnjazPlus-${field.replace(/\s/g, '-')}${ext}`
          const file = path.join(tmp, `${Date.now()}-${name}`)
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
          try { if (await saveOnProfile(db, profileId, field, file, name)) set({ files: (state().files || 0) + 1 }) }
          finally { fs.rmSync(file, { force: true }) }
        }
      }
      done.add(String(e._id))
      fs.writeFileSync(progressFile, JSON.stringify([...done]))
      set({ step: `Copying everyone: ${++finished} of ${all.length}` })
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  if (done.size >= all.length) fs.rmSync(progressFile, { force: true })
}
