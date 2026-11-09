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
function listen(page) {
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
  const onPool = POOL_PATH.test(new URL(url).pathname)
  if (!onPool && !page.__adalToPool) {
    const dash = !!(await import('./musanedWorkflow.js').then(w => w.snapshotState(page)).catch(() => null))?.hasDashboardNav
    if (dash) { page.__adalToPool = true; await openPool(page) }
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
export async function* poolByPages(page, { check = () => {}, wait = sleep, say = () => {} } = {}) {
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
  // Its first page, fresh.
  let t = Date.now()
  if (POOL_PATH.test(new URL(page.url()).pathname)) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  else await openPool(page)
  let list = await next(t, 45000)
  if (!list) throw new Error('The Musaned HR pool did not show its list. Press the button again: it goes on from where it stopped.')
  const size = Math.max(1, Number(list.size) || list.content.length || 10)
  const total = Number(list.totalElements ?? list.content.length)
  const pages = Math.max(1, Math.ceil(total / size))
  for (let n = 1; ; n++) {
    yield { ...list, page: n, pages, total }
    if (n >= pages || !list.content.length) return
    // A person's pace between pages.
    await wait(900 + Math.floor(Math.random() * 900))
    say(`HR pool page ${n + 1} of ${pages}`)
    let got = null
    for (let tries = 0; tries < 3 && !got; tries++) {
      t = Date.now()
      if (!(await clickPage(page, n + 1))) { await wait(2000); continue }
      got = await next(t, 30000)
    }
    if (!got) throw new Error(`The Musaned HR pool did not go to page ${n + 1}. Press the button again: it goes on from where it stopped.`)
    list = got
  }
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

export async function copyMusaned({ db, token, folder, set, state, check, readPerson, save, ask = fetch, wait = sleep, limit = Infinity, progressName = 'musaned-progress.json', pool }) {
  const cred = token
  const fresh = async () => cred?.page ? { ...(await credOf(cred.page)), auth: listen(cred.page).auth || cred.auth } : cred
  // Her details and pictures: once, slowly. Musaned refusing them is not a
  // reason to reload or sign in again — she is kept from her row.
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

  const records = path.join(folder, 'records')
  fs.mkdirSync(records, { recursive: true })
  const progressFile = path.join(path.dirname(folder), progressName)
  let done = new Set()
  try { done = new Set(JSON.parse(fs.readFileSync(progressFile, 'utf8'))) } catch {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-musaned-'))
  const pages = pool ? pool() : poolByPages(cred.page, { check, wait, say: (step) => set({ step }) })
  let seenRows = 0, total = 0, copied = 0, statuses = 0
  set({ status: 'copying', step: 'Opening the HR pool' })
  try {
    for await (const list of pages) {
      check()
      total = list.total ?? list.totalElements ?? total
      set({ people: total, step: `HR pool page ${list.page || '?'} of ${list.pages || '?'} — ${seenRows} of ${total} looked at` })
      for (const row of list.content || []) {
        check()
        seenRows++
        const id = idOf(row)
        if (id == null) continue
        const key = String(id)
        let passport = passportOf(row, readPerson)
        const had = passport ? await db('profiles').whereRaw("UPPER(REPLACE(REPLACE(REPLACE(passport_number, ' ', ''), '-', ''), '.', '')) = ?", [passport.replace(/[.-]/g, '')]).first('id', 'musaned_stage').catch(() => null) : null
        // Her status, as Musaned's list shows it now.
        const stage = statusOf(row)
        if (had) {
          const to = newerStage(had.musaned_stage, stage)
          if (to) { await db('profiles').where('id', had.id).update({ musaned_stage: to, updated_at: new Date().toISOString() }).catch(() => {}); statuses++; set({ updated: (state().updated || 0) + 1 }) }
          if (done.has(key)) continue
        }
        if (done.has(key) || copied >= limit) continue
        // Not here yet (or never copied): her details and pictures.
        const details = had ? {} : (await get(`/api/hrpool/${key}`))?.json || {}
        const rec = { ...row, ...details }
        fs.writeFileSync(path.join(records, `${key}.json`), JSON.stringify(rec, null, 1))
        const fromMusaned = Object.fromEntries(Object.entries(fieldsFromMusaned(rec)).filter(([, v]) => v))
        passport ||= passportOf(rec, readPerson)
        const name = fromMusaned.full_name || readPerson(rec)?.full_name || ''
        if (passport && name) {
          const profileId = await save({ ...(readPerson(rec) || {}), ...fromMusaned, full_name: name, passport_number: passport, ...(stage && !had ? { musaned_stage: stage.toUpperCase() } : {}) })
          if (!had) for (const [kind, field] of [['PASSPORT', 'Passport'], ['PERSONAL', 'Photo']]) {
            check()
            const f = await get(`/api/hrpool/${key}/photo/${kind}`, { binary: true })
            if (!f?.buf?.length) continue
            const ext = TYPES.find(([re]) => re.test(f.type))?.[1] || '.jpg'
            const fname = `${passport}-Musaned-${field}${ext}`
            const file = path.join(tmp, `${Date.now()}-${fname}`)
            fs.writeFileSync(file, f.buf)
            try { if (await saveOnProfile(db, profileId, field, file, fname)) set({ files: (state().files || 0) + 1 }) }
            finally { fs.rmSync(file, { force: true }) }
          }
          copied++
          if (!had) await wait(700)
        }
        done.add(key)
        fs.writeFileSync(progressFile, JSON.stringify([...done]))
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  set({ step: `HR pool: ${seenRows} looked at, ${statuses} status(es) updated${refused >= 5 ? ' — Musaned did not give the details of some: they were kept from the list' : ''}` })
  if (total && seenRows >= total) fs.rmSync(progressFile, { force: true })
}
