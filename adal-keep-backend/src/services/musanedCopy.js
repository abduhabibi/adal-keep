/**
 * Musaned (tawtheeq.musaned.com.sa) — everyone in the agency's HR pool, the
 * way a person looks at it: the HR pool page only, its pages of 10 one after
 * the other (its own ‹ 1 2 3 … › buttons), never any other Musaned page.
 *
 * What the HR pool page itself asks Musaned for (GET /api/search/hrpool?page=
 * &size= → { content, totalElements }) is read as it goes by: no list is asked
 * for in another size or faster than a person turns the pages. Each one's
 * status there updates her profile. Someone not in Adal Keep yet gets her
 * details (/api/hrpool/<id>) and her passport and photo
 * (/api/hrpool/<id>/photo/PASSPORT|PERSONAL) — once, slowly; when Musaned
 * refuses those, she is kept from her row alone (no reload, no new sign-in).
 * Nothing on Musaned is changed: it only reads.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveOnProfile, fieldsFromMusaned } from './musanedImport.js'
import { newerStage } from './musanedStages.js'

const ORIGIN = 'https://tawtheeq.musaned.com.sa'
const POOL_PATH = /^\/hr-pool\/?$/
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TYPES = [[/pdf/i, '.pdf'], [/png/i, '.png'], [/webp/i, '.webp'], [/jpe?g/i, '.jpg']]
const isPoolList = (u) => /\/api\/search\/hrpool(\?|$)/.test(u)

/** Listens to the window's own calls to Musaned: the token they carry, and the HR pool lists it gets. */
export function listen(page) {
  if (page.__adalMusaned) return page.__adalMusaned
  const seen = page.__adalMusaned = { auth: null, at: 0, lists: [], pool: false }
  page.on('request', (r) => {
    const u = r.url(), h = r.headers()
    if (u.startsWith(`${ORIGIN}/api/`) && h.authorization) { seen.auth = h.authorization; seen.at = Date.now() }
  })
  page.on('response', async (r) => {
    try {
      if (!isPoolList(r.url()) || r.request().method() !== 'GET' || r.status() !== 200) return
      const json = await r.json()
      if (!Array.isArray(json?.content)) return
      seen.pool = true
      seen.lists.push({ url: r.url(), json, at: Date.now() })
      if (seen.lists.length > 20) seen.lists.shift()
    } catch {}
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

/** To the HR pool the way a person goes: its menu link (the address only when the menu has none). */
async function openPool(page) {
  const link = await page.evaluateHandle(() => [...document.querySelectorAll('a[href]')]
    .find(a => /\/hr-pool\/?$/i.test(new URL(a.href, location.href).pathname) && a.getBoundingClientRect().width > 0) || null).catch(() => null)
  const el = link?.asElement?.()
  if (el) { await el.click().catch(() => el.evaluate(a => a.click())); return }
  await page.goto(`${ORIGIN}/hr-pool`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
}

/** Musaned's own "Access Denied" page (/403): the HR pool was opened before the agency was picked. */
export const onDenied = (page) => page.evaluate(() => /^\/403\b/.test(location.pathname) || /^\s*access denied\s*$/im.test(document.body?.innerText || '')).catch(() => false)

/**
 * Back from Access Denied the way a person goes: Musaned's start page, the
 * agency's own card, Go to Dashboard — then the HR pool from its menu.
 */
async function backFromDenied(page) {
  page.__adalDenied = (page.__adalDenied || 0) + 1
  if (page.__adalDenied > 3) throw new Error('Musaned keeps showing "Access Denied" for the HR pool. Sign in with the agency\'s own Musaned account (its HR pool), then press the button again: it goes on from where it stopped.')
  page.__adalToPool = false
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(2500)
}

/** On the way to the HR pool: the agency picked (its card, Go to Dashboard) before anything else. */
async function toDashboard(page) {
  const w = await import('./musanedWorkflow.js')
  const s = await w.snapshotState(page).catch(() => null)
  if (!s) return false
  const ctx = page.__adalMusanedCtx || null
  if (s.hasAgencyPicker) {
    // The person picks it when there is no saved account to tell which.
    if (ctx) { await w.stepClickAgencyCard(page, ctx).catch(() => {}); await w.stepClickGoToDashboard(page, ctx).catch(() => {}) }
    return false
  }
  if (s.hasGoToDashboard && !s.hasDashboardNav) { await w.stepClickGoToDashboard(page, ctx || {}).catch(() => {}); return false }
  return !!s.hasDashboardNav
}

/**
 * Signed in, once the window's HR pool page has had its list from Musaned:
 * { auth, cookie, page } — else null (still signing in). From the dashboard it
 * goes to the HR pool by its menu (never in the middle of the sign-in).
 */
export async function signedInMusaned(page) {
  const seen = listen(page)
  const url = page.url()
  if (!url.startsWith(ORIGIN)) return null
  if (seen.pool && seen.auth) return credOf(page)
  if (await onDenied(page)) { await backFromDenied(page); return null }
  const onPool = POOL_PATH.test(new URL(url).pathname)
  if (!onPool && !page.__adalToPool && await toDashboard(page)) { page.__adalToPool = true; await openPool(page) }
  // On the HR pool, its list not seen (it came before Adal Keep was listening,
  // or the page was opened too early): the page shown again, as a person presses F5.
  if (onPool && !seen.pool) {
    page.__adalPoolWait = (page.__adalPoolWait || 0) + 1
    if (page.__adalPoolWait === 2 || page.__adalPoolWait % 20 === 0) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  } else if (page.__adalToPool && !seen.pool) {
    page.__adalPoolWait = (page.__adalPoolWait || 0) + 1
    if (page.__adalPoolWait > 20) { page.__adalPoolWait = 0; page.__adalToPool = false }
  }
  return null
}

/** The paginator's button for page `n` (as it shows it, from 1), else its "next" arrow. */
async function clickPage(page, n) {
  const h = await page.evaluateHandle((n) => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const pagers = [...document.querySelectorAll('[class*="paginat" i], [class*="pager" i], nav[aria-label*="pag" i], ul.pagination')].filter(seen)
    const inside = pagers.flatMap(p => [...p.querySelectorAll('a, button, li, span')]).filter(seen)
    const num = inside.find(e => (e.innerText || '').trim() === String(n) && !e.querySelector('a, button'))
    if (num) return num.closest('a, button, li') || num
    const next = inside.find(e => /next|›|»|chevron-right|arrow-right/i.test(`${e.getAttribute('aria-label') || ''} ${e.className || ''} ${(e.innerText || '').trim()}`) && !/disabled/i.test(e.className || ''))
    return next || null
  }, n).catch(() => null)
  const el = h?.asElement?.()
  if (!el) return false
  await el.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {})
  await el.click().catch(() => el.evaluate(e => e.click()))
  return true
}

/**
 * The HR pool, page after page, as the page itself shows it: yields each list
 * Musaned gave the page ({ content, totalElements, size }).
 */
export async function* poolByPages(page, { check = () => {}, wait = sleep, say = () => {}, newest = 100 } = {}) {
  const seen = listen(page)
  const next = async (after, ms) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      check()
      const got = seen.lists.find(l => l.at > after)
      if (got) { seen.lists = seen.lists.filter(l => l.at > got.at); return got.json }
      await wait(300)
    }
    return null
  }
  // Its first page — the list the window already has, else the HR pool again
  // (Access Denied: back to the agency's dashboard first), a few times.
  let t = Date.now()
  let list = seen.lists.length && !(Number(seen.lists[0].json?.number) > 0) ? seen.lists.shift().json : null
  seen.lists = []
  for (let tries = 0; !list && tries < 3; tries++) {
    check()
    if (await onDenied(page)) { await backFromDenied(page).catch(() => {}); await toDashboard(page).catch(() => {}); await sleep(2000) }
    t = Date.now()
    if (tries) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    else await openPool(page)
    list = await next(t, 30000)
  }
  if (!list) throw new Error(await onDenied(page)
    ? 'Musaned showed "Access Denied" for the HR pool: sign in with the agency\'s own Musaned account, then press the button again.'
    : 'The Musaned HR pool did not show its list (is Musaned slow right now?). Press the button again.')
  const size = Math.max(1, Number(list.size) || list.content.length || 10)
  const total = Number(list.totalElements ?? list.content.length)
  const pages = Math.max(1, Math.ceil(total / size))
  const want = Math.min(pages, Math.max(1, Math.ceil(newest / size)))
  // A page the paginator goes to: its list, or null (tried 3 times).
  const goTo = async (n) => {
    for (let tries = 0; tries < 3; tries++) {
      check()
      await wait(900 + Math.floor(Math.random() * 900))   // a person's pace
      t = Date.now()
      if (!(await clickPage(page, n))) { await wait(2000); continue }
      const got = await next(t, 30000)
      if (got) return got
    }
    return null
  }
  // Which end is the newest: the dates on its rows (page 1 against the last page).
  let order = Array.from({ length: want }, (_, i) => i + 1)
  if (pages > want && newestOf(list) !== null) {
    say('Finding the newest girls')
    const last = await goTo(pages)
    if (last && newestOf(last) !== null && newestOf(last) > newestOf(list)) {
      order = Array.from({ length: want }, (_, i) => pages - i)    // the newest are at the end
      list = last
    } else if (last) {
      const first = await goTo(1)                                 // back to page 1
      if (first) list = first
    }
  }
  for (let i = 0; i < order.length; i++) {
    yield { ...list, page: order[i], pages, total, step: i + 1, steps: order.length }
    if (i + 1 >= order.length || !list.content.length) return
    say(`HR pool page ${order[i + 1]} (${i + 2} of ${order.length})`)
    const got = await goTo(order[i + 1])
    // A page that does not answer: what was copied stays; the move ends calmly.
    if (!got) { yield { content: [], stopped: `Musaned did not show page ${order[i + 1]}: the girls before it are copied. Press the button again for the rest.` }; return }
    list = got
  }
}

// The newest date on a list's rows (registered / created / added), or null when its rows carry none.
const DATE_KEYS = /creat|regist|added|insert|submit/i
function newestOf(list) {
  let best = null
  for (const r of list?.content || []) {
    for (const [k, v] of Object.entries(r || {})) {
      if (!DATE_KEYS.test(k) || typeof v !== 'string') continue
      const t = Date.parse(v)
      if (!Number.isNaN(t) && (best === null || t > best)) best = t
    }
  }
  return best
}

const idOf = (row) => row?.id ?? row?.candidateId ?? row?.hrPoolId ?? null
const passportOf = (r, readPerson) => String(r?.passportNumber || r?.passport_number || r?.passportNo || readPerson(r)?.passport_number || '').toUpperCase().replace(/\s/g, '')
/** Her status on Musaned's HR pool list (a word, or { nameEn }). */
export function statusOf(r = {}) {
  for (const k of ['contractStatus', 'candidateStatus', 'status', 'statusName', 'statusEn', 'state', 'stage']) {
    const v = r[k]
    const s = v && typeof v === 'object' ? (v.nameEn || v.name || v.value || v.code || '') : v
    if (s && typeof s === 'string' && s.trim()) return s.trim()
  }
  return ''
}

// An HR-pool status that only means "in the pool" (not chosen by an employer): no contract to fetch.
const POOL_ONLY = /^(available|in our list|new|ready|active|pending|under review|draft|in review|approved)$/i

/**
 * The newest `newest` girls of the HR pool (100): each one's every detail, her
 * photo and passport (when her profile has none), her status; and for those an
 * employer chose, the contract PDFs from Employment Requests (the same robot as
 * "Check if chosen"), each into its own Contract document.
 */
export async function copyMusaned({ db, token, folder, set, state, check, readPerson, save, ask = fetch, wait = sleep, limit = Infinity, newest = 100, progressName = 'musaned-progress.json', pool, contracts }) {
  const cred = token
  const fresh = async () => cred?.page ? { ...(await credOf(cred.page)), auth: listen(cred.page).auth || cred.auth } : cred
  // Her details and pictures, slowly. Musaned refusing them is not a reason
  // to reload or sign in again — she is kept from her row.
  let refused = 0
  const get = async (url, opts = {}) => {
    if (refused >= 5) return null
    for (let tries = 0; ; tries++) {
      check()
      const r = await call(await fresh(), url, opts, ask)
      if (r.status === 200) { refused = 0; return r }
      if (r.status === 401 && tries < 1) { await wait(3000); continue }        // the page renews its token: once more with it
      if ((r.status === 0 || r.status === 429 || r.status >= 500) && tries < 3) { await wait(4000 * (tries + 1)); continue }
      if (r.status === 401 || r.status === 403) refused++
      return null
    }
  }
  const hasFile = async (profileId, field) => !!(await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .where({ 'profile_fields.profile_id': profileId, 'profile_fields.name': field }).first('files.id').catch(() => null))

  const records = path.join(folder, 'records')
  fs.mkdirSync(records, { recursive: true })
  const progressFile = path.join(path.dirname(folder), progressName)
  fs.rmSync(progressFile, { force: true })   // the newest 100 are looked at again each time
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-musaned-'))
  const pages = pool ? pool() : poolByPages(cred.page, { check, wait, newest, say: (step) => set({ step }) })
  let seenRows = 0, total = 0, copied = 0, statuses = 0, stopped = ''
  const chosen = []   // profile ids to fetch the contract of
  set({ status: 'copying', step: 'Opening the HR pool' })
  try {
    for await (const list of pages) {
      check()
      if (list.stopped) { stopped = list.stopped; break }
      total = list.total ?? list.totalElements ?? total
      set({ people: Math.min(newest, total || newest), step: `HR pool page ${list.page || '?'}${list.steps ? ` (${list.step} of ${list.steps})` : ''} — ${seenRows} of ${Math.min(newest, total || newest)} copied` })
      for (const row of list.content || []) {
        check()
        if (seenRows >= newest || copied >= limit) break
        seenRows++
        const id = idOf(row)
        if (id == null) continue
        const key = String(id)
        let passport = passportOf(row, readPerson)
        const stage = statusOf(row)
        // Every detail of hers (filling only what her profile does not have yet).
        const details = (await get(`/api/hrpool/${key}`))?.json || {}
        const rec = { ...row, ...details }
        fs.writeFileSync(path.join(records, `${key}.json`), JSON.stringify(rec, null, 1))
        const fromMusaned = Object.fromEntries(Object.entries(fieldsFromMusaned(rec)).filter(([, v]) => v))
        passport ||= passportOf(rec, readPerson)
        const name = fromMusaned.full_name || readPerson(rec)?.full_name || ''
        if (!passport || !name) continue
        const had = await db('profiles').whereRaw("UPPER(REPLACE(REPLACE(REPLACE(passport_number, ' ', ''), '-', ''), '.', '')) = ?", [passport.replace(/[.-]/g, '')]).first('id', 'musaned_stage').catch(() => null)
        const profileId = await save({ ...(readPerson(rec) || {}), ...fromMusaned, full_name: name, passport_number: passport, ...(stage && !had ? { musaned_stage: stage.toUpperCase() } : {}) })
        if (had) {
          const to = newerStage(had.musaned_stage, stage)
          if (to) { await db('profiles').where('id', had.id).update({ musaned_stage: to, updated_at: new Date().toISOString() }).catch(() => {}); statuses++ }
        }
        // Her photo and passport, each where it belongs (only when her profile has none).
        for (const [kind, field] of [['PASSPORT', 'Passport'], ['PERSONAL', 'Photo']]) {
          check()
          if (await hasFile(profileId, field)) continue
          const f = await get(`/api/hrpool/${key}/photo/${kind}`, { binary: true })
          if (!f?.buf?.length) continue
          const ext = TYPES.find(([re]) => re.test(f.type))?.[1] || '.jpg'
          const fname = `${passport}-Musaned-${field}${ext}`
          const file = path.join(tmp, `${Date.now()}-${fname}`)
          fs.writeFileSync(file, f.buf)
          try { if (await saveOnProfile(db, profileId, field, file, fname)) set({ files: (state().files || 0) + 1 }) }
          finally { fs.rmSync(file, { force: true }) }
        }
        // Chosen by an employer: her contract comes after the list.
        if (stage && !POOL_ONLY.test(stage) && !(await hasFile(profileId, 'Contract'))) chosen.push(profileId)
        copied++
        await wait(700)
      }
      if (seenRows >= newest || copied >= limit) break
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  // The contracts of the chosen ones (Employment Requests → her passport → DETAILS → the PDFs).
  let withContract = 0
  if (chosen.length) {
    const fetchOne = contracts || (async (profileId) => {
      const { checkContracts, contractCheck } = await import('./musanedContracts.js')
      for (let i = 0; i < 60 && contractCheck.running; i++) await wait(5000)   // the 4-hourly check finishing first
      await checkContracts(db, { onlyId: profileId })
      return contractCheck.results.find(r => r.id === profileId)
    })
    for (const [i, profileId] of chosen.entries()) {
      check()
      set({ step: `Contracts: ${i + 1} of ${chosen.length}` })
      try { const r = await fetchOne(profileId); if (r?.state === 'chosen' || (await hasFile(profileId, 'Contract'))) withContract++ } catch {}
    }
  }
  set({ step: [`Newest ${seenRows} of the HR pool copied`, statuses && `${statuses} status(es) updated`, chosen.length && `${withContract} of ${chosen.length} contract(s) saved`,
    refused >= 5 && 'Musaned did not give the details of some: they were kept from the list', stopped].filter(Boolean).join(' · ') })
}
