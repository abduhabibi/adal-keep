/**
 * Musaned (tawtheeq.musaned.com.sa) — everyone in the agency's HR pool, in one visit.
 *
 * Its HR pool page lists people from GET /api/search/hrpool?page=&size=
 * ({ content, totalElements }); each person's details are /api/hrpool/<id>,
 * her passport and personal photo /api/hrpool/<id>/photo/PASSPORT|PERSONAL.
 * Musaned signs these calls with a token its own page keeps fresh (Keycloak),
 * so the signed-in window stays open on the HR pool: the token its calls carry
 * is taken from there, and when it runs out the page is reloaded for a new one.
 * Nothing on Musaned is changed: it only reads.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveOnProfile, fieldsFromMusaned } from './musanedImport.js'

const ORIGIN = 'https://tawtheeq.musaned.com.sa'
const PAGE = 100
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TYPES = [[/pdf/i, '.pdf'], [/png/i, '.png'], [/webp/i, '.webp'], [/jpe?g/i, '.jpg']]

/** Listens to the window's own calls to Musaned's API: the token they carry. */
function listen(page) {
  if (page.__adalMusaned) return page.__adalMusaned
  const seen = page.__adalMusaned = { auth: null, at: 0 }
  page.on('request', (r) => {
    const u = r.url(), h = r.headers()
    if (u.startsWith(`${ORIGIN}/api/`) && h.authorization) { seen.auth = h.authorization; seen.at = Date.now() }
  })
  return seen
}

async function credOf(page) {
  const seen = listen(page)
  const cookies = await page.cookies(ORIGIN).catch(() => [])
  return { auth: seen.auth, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), page }
}

async function call(cred, url, { binary = false } = {}, ask = fetch) {
  const headers = { Accept: binary ? '*/*' : 'application/json', Referer: `${ORIGIN}/hr-pool` }
  if (cred?.auth) headers.Authorization = cred.auth
  if (cred?.cookie) headers.Cookie = cred.cookie
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), binary ? 300_000 : 120_000)
  try {
    const r = await ask(`${ORIGIN}${url}`, { headers, signal: ctl.signal })
    if (!r.ok) return { status: r.status }
    if (binary) return { status: 200, type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) }
    return { status: 200, json: await r.json().catch(() => null) }
  } catch (e) { return { status: 0, error: e.message } } finally { clearTimeout(t) }
}

/**
 * Signed in, once the window's own calls carry a token that the HR pool list
 * answers to: { auth, cookie, page } — else null (still signing in).
 */
export async function signedInMusaned(page, ask = fetch) {
  const seen = listen(page)
  const url = page.url()
  if (!url.startsWith(ORIGIN)) return null
  // On Musaned but no API call seen yet: the HR pool page makes them.
  // (only from the dashboard: never in the middle of the sign-in or the agency's card)
  const onDashboard = !seen.auth && !/\/hr-pool/.test(url) && !page.__adalToPool
    && !!(await import('./musanedWorkflow.js').then(w => w.snapshotState(page)).catch(() => null))?.hasDashboardNav
  if (onDashboard) {
    page.__adalToPool = true
    await page.goto(`${ORIGIN}/hr-pool`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    return null
  }
  if (!seen.auth) return null
  const cred = await credOf(page)
  const r = await call(cred, '/api/search/hrpool?page=0&size=1', {}, ask)
  return r.status === 200 && r.json ? cred : null
}

/** A fresh token: the HR pool page reloaded in the window makes new calls. */
async function freshToken(cred) {
  const page = cred?.page
  if (!page || page.isClosed?.()) return null
  const seen = listen(page), before = seen.at
  await page.goto(`${ORIGIN}/hr-pool`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  for (let i = 0; i < 40 && seen.at === before; i++) await sleep(500)
  return seen.at !== before ? credOf(page) : null
}

const idOf = (row) => row?.id ?? row?.candidateId ?? row?.hrPoolId ?? null

export async function copyMusaned({ db, token, folder, set, state, check, readPerson, save, signIn, ask = fetch, wait = sleep, limit = Infinity, progressName = 'musaned-progress.json' }) {
  let cred = token
  const get = async (url, opts = {}) => {
    for (let tries = 0, renewals = 0; ;) {
      check()
      const r = await call(cred, url, opts, ask)
      if (r.status === 200) return r
      if ((r.status === 401 || r.status === 403) && renewals++ < 3) {
        cred = (await freshToken(cred)) || await signIn()
        continue
      }
      if (r.status === 404) return null
      if (tries++ < 4 && (r.status === 0 || r.status === 429 || r.status >= 500)) { await wait(4000 * tries); continue }
      return null
    }
  }

  // Everyone in the HR pool.
  set({ status: 'copying', step: 'Reading the HR pool' })
  const rows = []
  for (let page = 0; ; page++) {
    const r = await get(`/api/search/hrpool?page=${page}&size=${PAGE}`)
    if (!r?.json) throw new Error('Musaned did not give the whole HR pool list: check the internet and press the button again. It goes on from where it stopped.')
    const got = r.json.content || []
    rows.push(...got)
    const total = Number(r.json.totalElements ?? rows.length)
    set({ step: `Reading the HR pool: ${rows.length} of ${total}` })
    if (!got.length || rows.length >= total) break
  }
  if (!rows.length) throw new Error('The HR pool is empty for this Musaned account.')

  const records = path.join(folder, 'records')
  fs.mkdirSync(records, { recursive: true })
  const progressFile = path.join(path.dirname(folder), progressName)
  let done = new Set()
  try { done = new Set(JSON.parse(fs.readFileSync(progressFile, 'utf8'))) } catch {}
  const todo = rows.filter(r => idOf(r) != null && !done.has(String(idOf(r)))).slice(0, limit)
  set({ people: rows.length })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-musaned-'))
  let finished = rows.length - todo.length
  try {
    for (const row of todo) {
      check()
      const id = String(idOf(row))
      const details = (await get(`/api/hrpool/${id}`))?.json || {}
      const rec = { ...row, ...details }
      fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify(rec, null, 1))
      const fromMusaned = Object.fromEntries(Object.entries(fieldsFromMusaned(rec)).filter(([, v]) => v))
      const passport = String(rec.passportNumber || rec.passport_number || readPerson(rec)?.passport_number || '').toUpperCase().replace(/\s/g, '')
      const name = fromMusaned.full_name || readPerson(rec)?.full_name || ''
      if (passport && name) {
        const profileId = await save({ ...(readPerson(rec) || {}), ...fromMusaned, full_name: name, passport_number: passport })
        for (const [kind, field] of [['PASSPORT', 'Passport'], ['PERSONAL', 'Photo']]) {
          check()
          const f = await get(`/api/hrpool/${id}/photo/${kind}`, { binary: true })
          if (!f?.buf?.length) continue
          const ext = TYPES.find(([re]) => re.test(f.type))?.[1] || '.jpg'
          const fname = `${passport}-Musaned-${field}${ext}`
          const file = path.join(tmp, `${Date.now()}-${fname}`)
          fs.writeFileSync(file, f.buf)
          try { if (await saveOnProfile(db, profileId, field, file, fname)) set({ files: (state().files || 0) + 1 }) }
          finally { fs.rmSync(file, { force: true }) }
        }
      }
      done.add(id)
      fs.writeFileSync(progressFile, JSON.stringify([...done]))
      set({ step: `Copying everyone: ${++finished} of ${rows.length}` })
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  if (done.size >= rows.length) fs.rmSync(progressFile, { force: true })
}
