/**
 * selectionCheck.js — "Check for new selections" (who an employer chose on
 * Musaned), every hour by itself, on ONE PC of the agency (asked on 2026-11-19).
 *
 * The main PC decides. Every PC (the main PC and each Companion) tells it
 * every minute how strong it is (CPU cores, free RAM) and whether its Musaned
 * tab is signed in (the tab stays signed in all day: Morning sign-in). When
 * the hour is up the main PC gives the turn — a lease — to the strongest one
 * with a signed-in Musaned tab (equal: any of them, the last one first). The
 * lease lives only while that PC keeps answering (3 minutes): a PC that goes
 * away loses it, and at the next minute another PC takes over.
 *
 * Two PCs never check at once: the main PC holds the one check
 * (musanedContracts.contractCheck) and saves everything itself. A Companion
 * holding the lease only reads Musaned in its own tab, step by step as the
 * main PC asks (/api/selection-check/remote/next → …/answer).
 *
 * "Check now" (the Waiting page) checks on the main PC at once, with a
 * 10-minute time limit and Cancel. With the main PC off nothing is checked:
 * there is nowhere to save what Musaned shows (the online copy only shows
 * what the main PC sent).
 *
 * The daily Wafid result check (asked on 2026-11-19) uses the same turn: once
 * a day in working hours the girls in the Wafid tab are looked up on wafid.com
 * by ONE PC (the strongest with Adal Browser open), never beside the hourly
 * check or a robot's run. See "The daily Wafid result check" below.
 */
import os from 'os'
import crypto from 'crypto'
// ("isFollower" here: not the PC holding the main PC's role, a follower or a Companion with its own copy.)
import { mainURL, mainKey, instanceId, notMainPC as isFollower } from './mainPC.js'

export const EVERY_MS = 60 * 60e3          // once an hour
export const MANUAL_LIMIT_MS = 10 * 60e3   // Check now: at most 10 minutes
export const AUTO_LIMIT_MS = 30 * 60e3     // the hourly check: at most 30 minutes
const SEEN_MS = 3 * 60e3                   // a PC not heard from for 3 minutes is gone
const LEASE_MS = 3 * 60e3                  // renewed by every answer of the checking PC
const ASK_MS = 2 * 60e3                    // one step on the other PC
const RETRY_MS = 15 * 60e3                 // nobody could check: again in 15 minutes
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function powerNow() {
  return { cores: os.cpus()?.length || 1, free_mb: Math.round(os.freemem() / 1048576) }
}
const myName = () => `${os.hostname()}${isFollower() ? '' : ' (main PC)'}`

/** Is this PC's Musaned tab signed in (Morning sign-in keeps it so)? */
async function musanedHere() {
  try {
    const { kept } = await import('./sessionKeeper.js')
    if (!kept.musaned?.signedIn) return false
    const { openBrowserIfAny } = await import('./browser.js')
    return !!(await openBrowserIfAny())
  } catch { return false }
}

/**
 * The PC that checks: only one with Musaned signed in; the most CPU cores,
 * then the most free RAM (whole GB: a few MB more is "equal"); equal → the
 * one that checked last time, else any (the first). need: 'musaned' (the
 * hourly check) or 'browser' (the daily Wafid check: Adal Browser open).
 */
export function pickLeader(list, last = '', need = 'musaned') {
  const gb = (p) => Math.floor((Number(p.free_mb) || 0) / 1024)
  const ok = list.filter(p => p && p[need])
  ok.sort((a, b) => ((Number(b.cores) || 0) - (Number(a.cores) || 0)) || (gb(b) - gb(a)) || ((b.instance === last) - (a.instance === last)))
  return ok[0] || null
}

// ── On the main PC ──────────────────────────────────────────────────────────

const pcs = new Map()              // instance → { instance, name, cores, free_mb, musaned, at }
// kind: 'musaned' (the hourly check) or 'wafid' (the daily one) — one lease, so never both at once.
export const lease = { holder: '', name: '', token: '', until: 0, manual: false, kind: '' }
const FREE = { holder: '', name: '', token: '', until: 0, manual: false, kind: '' }
const skipUntil = new Map()        // a PC that did not take its turn: passed over for a while
let lastDone = 0, notBefore = 0, lastLeader = '', lastWhy = ''
let remote = null                  // the steps waiting for the Companion that holds the lease

function selfPc(musaned = false, browser = false) {
  return { instance: instanceId(), name: myName(), ...powerNow(), musaned, browser, at: Date.now(), main: true }
}
async function browserHere() {
  try { const { openBrowserIfAny } = await import('./browser.js'); return !!(await openBrowserIfAny()) } catch { return false }
}

/** A Companion says it is here (every minute). Its turn → the lease's token. */
export function hello(info = {}) {
  const instance = String(info.instance || '').slice(0, 40)
  if (!instance || instance === instanceId()) return { error: 'no instance' }
  pcs.set(instance, {
    instance, name: String(info.name || 'A Companion PC').slice(0, 80),
    cores: Number(info.cores) || 1, free_mb: Number(info.free_mb) || 0, musaned: !!info.musaned, browser: !!info.browser, at: Date.now(),
  })
  if (lease.holder === instance && lease.token && remote?.token === lease.token) {
    lease.until = Date.now() + LEASE_MS
    return { run: lease.token, kind: lease.kind || 'musaned' }
  }
  return { leader: lease.name || '' }
}

/** Musaned read in the Companion's tab: each step is asked and waits for its answer. */
function remoteSource(token, name, cancelable) {
  const r = { token, queue: [], waiting: new Map(), pollers: [], ended: false }
  remote = r
  const wake = () => { for (const w of r.pollers.splice(0)) w() }
  const ask = (kind, args) => cancelable(new Promise((resolve, reject) => {
    if (r.ended) return reject(new Error(`${name} let go`))
    const id = crypto.randomBytes(8).toString('hex')
    const t = setTimeout(() => { r.waiting.delete(id); reject(new Error(`${name} did not answer`)) }, ASK_MS)
    r.waiting.set(id, { resolve, reject, t })
    r.queue.push({ id, kind, args })
    wake()
  }))
  return {
    headers: () => ask('headers', {}),
    api: (url, o = {}) => ask('api', { url, binary: !!o.binary }),
    contract: (card) => ask('contract', { card: { id: card.id, contract_number: card.contract_number } }),
    pdf: async (name) => Buffer.from(String(await ask('pdf', { name }) || ''), 'base64'),
    _ask: ask,
    end: () => {
      r.ended = true
      for (const [, w] of r.waiting) { clearTimeout(w.t); w.reject(new Error('ended')) }
      r.waiting.clear()
      wake()
    },
  }
}

export const _remoteSourceForTest = remoteSource
export const _tickForTest = (db) => tick(db)

/** The Companion asks for its next step (waits up to 25 s for one). */
export async function nextStep(token) {
  const r = remote
  if (!r || !token || r.token !== token || r.ended || lease.token !== token) return { done: true }
  lease.until = Date.now() + LEASE_MS
  if (!r.queue.length) await new Promise(res => { const t = setTimeout(res, 25000); r.pollers.push(() => { clearTimeout(t); res() }) })
  if (r.ended || lease.token !== token) return { done: true }
  return r.queue.shift() || { wait: true }
}

/** …and answers it. */
export function answerStep(token, { id, ok, result, error } = {}) {
  const r = remote
  if (!r || !token || r.token !== token) return { done: true }
  lease.until = Date.now() + LEASE_MS
  const w = r.waiting.get(String(id || ''))
  if (!w) return { ok: false }
  r.waiting.delete(String(id)); clearTimeout(w.t)
  if (ok) w.resolve(result); else w.reject(new Error(String(error || 'failed').slice(0, 300)))
  return { ok: true }
}

async function runOn(db, pc, { manual = false } = {}) {
  const token = crypto.randomBytes(12).toString('hex')
  // Taken at once (before any await): the daily Wafid check sees it in the same minute.
  Object.assign(lease, { holder: pc.instance, name: pc.name, token, until: Date.now() + LEASE_MS, manual, kind: 'musaned' })
  lastLeader = pc.instance
  const limitMs = manual ? MANUAL_LIMIT_MS : AUTO_LIMIT_MS
  try {
    const mc = await import('./musanedContracts.js')
    if (pc.instance === instanceId()) return await mc.scanContracts(db, { auto: !manual, limitMs, by: pc.name })
    console.log(`[selection-check] ${pc.name} checks Musaned (${pc.cores} cores, ${Math.round(pc.free_mb / 1024)} GB free)`)
    return await mc.scanContracts(db, { auto: true, limitMs, by: pc.name, remote: remoteSource(token, pc.name, mc.cancelable) })
  } finally {
    if (lease.token === token) Object.assign(lease, FREE)
    if (remote?.token === token) remote = null
  }
}

// ── The daily Wafid result check (on the main PC) ───────────────────────────
//
// Once a day, in working hours, while the PCs are on: the girls in the Wafid
// tab are looked up on wafid.com (wafidStatus.checkAll, the same look-up as the
// button). FIT → Medical · Fit (her next step), UNFIT → the Unfit tab. It runs
// on ONE PC of the agency — the same choice as the hourly check (pickLeader),
// among the PCs with Adal Browser open — and never beside another check or a
// robot's run: one agent at a time, one try a day (no retries after it ran).

export const WAFID_HOURS = [9, 17]        // 09:00–17:00, this PC's clock
const WAFID_DAY_KEY = 'wafid_daily_done'  // settings: the last day it ran (YYYY-MM-DD)
const today = (d = new Date()) => d.toLocaleDateString('en-CA')
/** Working hours: Monday to Saturday, 09:00–17:00. */
export function inWorkingHours(d = new Date()) {
  return d.getDay() !== 0 && d.getHours() >= WAFID_HOURS[0] && d.getHours() < WAFID_HOURS[1]
}
export const wafidDaily = { lastDay: '', notBefore: 0, why: '', running: false, by: '', last: null }

async function wafidDoneDay(db) {
  if (wafidDaily.lastDay) return wafidDaily.lastDay
  const row = await db('settings').where('key', WAFID_DAY_KEY).first().catch(() => null)
  return (wafidDaily.lastDay = String(row?.value || ''))
}
async function markWafidDay(db, day) {
  wafidDaily.lastDay = day
  const now = new Date().toISOString()
  try {
    if (await db('settings').where('key', WAFID_DAY_KEY).first()) await db('settings').where('key', WAFID_DAY_KEY).update({ value: day, updated_at: now })
    else await db('settings').insert({ key: WAFID_DAY_KEY, value: day, created_at: now, updated_at: now })
  } catch (e) { console.warn('[wafid-daily] could not note the day:', e.message) }
}

/** Wafid read in the Companion's tab: one passport at a time, as the main PC asks. */
function wafidSource(token, name) {
  const src = remoteSource(token, name, (p) => p)
  return { ...src, wafid: (passport) => src._ask('wafid', { passport }) }
}

async function runWafidOn(db, pc, list) {
  const token = crypto.randomBytes(12).toString('hex')
  Object.assign(lease, { holder: pc.instance, name: pc.name, token, until: Date.now() + LEASE_MS, manual: false, kind: 'wafid' })
  Object.assign(wafidDaily, { running: true, by: pc.name })
  lastLeader = pc.instance
  const here = pc.instance === instanceId()
  // Ready at once: the Companion's next hello gets its turn.
  const src = here ? null : wafidSource(token, pc.name)
  try {
    const { checkAll } = await import('./wafidStatus.js')
    const shouldStop = () => lease.token !== token ? `${pc.name} went away` : ''
    if (here) return await checkAll(db, { list, auto: true, by: pc.name, shouldStop })
    console.log(`[wafid-daily] ${pc.name} checks Wafid (${list.length} girl(s))`)
    return await checkAll(db, { list, auto: true, by: pc.name, shouldStop, look: (passport) => src.wafid(passport) })
  } finally {
    src?.end()
    if (lease.token === token) Object.assign(lease, FREE)
    if (remote?.token === token) remote = null
    Object.assign(wafidDaily, { running: false, last: new Date().toISOString() })
  }
}

async function wafidTick(db, now = new Date()) {
  if (!inWorkingHours(now) || Date.now() < wafidDaily.notBefore || lease.token) return
  const day = today(now)
  if (await wafidDoneDay(db) === day) return
  const { contractCheck } = await import('./musanedContracts.js')
  const { checker } = await import('./wafidStatus.js')
  if (contractCheck.running || checker.running || lease.token) return
  const working = await db('automation_queue').where('status', 'running').first('id').catch(() => null)
  if (working) return
  const { wafidTabProfiles } = await import('../routes/automations.js')
  const list = await wafidTabProfiles(db)
  if (!list.length) { await markWafidDay(db, day); wafidDaily.why = 'Nobody is in the Wafid tab'; return }
  const pc = pickLeader([...pcs.values()].filter(p => !(skipUntil.get(p.instance) > Date.now())), lastLeader, 'browser')
  if (!pc) {
    wafidDaily.why = 'No PC has Adal Browser open'
    wafidDaily.notBefore = Date.now() + RETRY_MS
    return
  }
  if (lease.token) return
  runWafidOn(db, pc, list).then(async (r) => {
    if (r?.busy || r?.skipped) { wafidDaily.notBefore = Date.now() + RETRY_MS; wafidDaily.why = r.busy ? 'Another check was on' : 'Adal Browser was closed'; return }
    if (r?.stopped && /went away/.test(r.stopped) && !r.checked) {
      skipUntil.set(pc.instance, Date.now() + RETRY_MS)
      wafidDaily.notBefore = Date.now() + 60e3
      wafidDaily.why = r.stopped
      return
    }
    // It ran: once today, whatever Wafid said (one try).
    await markWafidDay(db, day)
    const fit = (r?.results || []).filter(x => x.state === 'fit').length
    const unfit = (r?.results || []).filter(x => x.state === 'unfit').length
    wafidDaily.why = r?.stopped || ''
    console.log(`[wafid-daily] on ${pc.name}: ${r?.checked ?? 0} checked, ${fit} FIT, ${unfit} UNFIT${r?.stopped ? ` — stopped: ${r.stopped}` : ''}`)
  }).catch(e => { wafidDaily.why = e.message; wafidDaily.notBefore = Date.now() + RETRY_MS })
}
export const _wafidTickForTest = (db, now) => wafidTick(db, now)
export const _pcsForTest = pcs

const finished = (r) => r && !r.busy && !r.skipped && !r.cancelled && !r.error && !r.signedOut

/** Check now (a person): on this main PC at once, unless a check is on. */
export async function checkNow(db) {
  const { contractCheck } = await import('./musanedContracts.js')
  if (contractCheck.running || lease.token) return { busy: true, by: lease.name || contractCheck.by || '' }
  runOn(db, selfPc(await musanedHere()), { manual: true })
    .then(r => { if (finished(r)) lastDone = Date.now() })
    .catch(e => console.warn('[contracts] check now failed:', e.message))
  return { started: true, limit_ms: MANUAL_LIMIT_MS }
}

export async function cancelNow() {
  const { cancelCheck } = await import('./musanedContracts.js')
  return { cancelled: cancelCheck('Cancelled') }
}

/** For the Waiting page: who checks, when last, when next. */
export function checkInfo() {
  const live = [...pcs.values()].filter(p => Date.now() - p.at < SEEN_MS)
  const next = lastDone ? Math.max(lastDone + EVERY_MS, notBefore) : notBefore
  return {
    checking_on: lease.name || '', last_done: lastDone ? new Date(lastDone).toISOString() : null,
    next_at: next ? new Date(next).toISOString() : null, why: lastWhy,
    pcs: live.map(p => ({ name: p.name, cores: p.cores, free_gb: Math.round(p.free_mb / 1024), musaned: p.musaned, main: !!p.main })),
    every_min: EVERY_MS / 60000, manual_limit_min: MANUAL_LIMIT_MS / 60000,
    wafid_daily: { last_day: wafidDaily.lastDay || null, checking_on: wafidDaily.running ? wafidDaily.by : '', why: wafidDaily.why, hours: WAFID_HOURS },
  }
}

// Every minute on the main PC: the hourly check first, then the daily Wafid one
// (each takes the one lease at once, so the second sees the first started).
async function tick(db) {
  // A robot run has the internet (runFocus.js): the chosen check and Wafid's daily look after it.
  const RF = await import('./runFocus.js')
  if (RF.held('the chosen check')) { RF.later('the chosen check', () => tick(db)); return }
  await selectionTick(db)
  await wafidTick(db)
}

async function selectionTick(db) {
  const { contractCheck, cancelCheck } = await import('./musanedContracts.js')
  const me = instanceId()
  pcs.set(me, selfPc(await musanedHere(), await browserHere()))
  for (const [k, p] of pcs) if (Date.now() - p.at > SEEN_MS) pcs.delete(k)
  // The checking PC stopped answering: its lease ends, the next PC takes over.
  if (lease.token && lease.holder !== me && Date.now() > lease.until) {
    console.warn(`[selection-check] ${lease.name} went away — another PC takes over`)
    skipUntil.set(lease.holder, Date.now() + 10 * 60e3)
    if (lease.kind === 'wafid') { remote?.end(); Object.assign(lease, FREE) }
    else cancelCheck(`${lease.name} went away`)
    return
  }
  if (contractCheck.running || lease.token) return
  if (Date.now() - lastDone < EVERY_MS || Date.now() < notBefore) return
  // One agent at a time: never while a robot works (it has the internet first).
  const working = await db('automation_queue').where('status', 'running').first('id').catch(() => null)
  if (working) return
  const pc = pickLeader([...pcs.values()].filter(p => !(skipUntil.get(p.instance) > Date.now())), lastLeader)
  if (!pc) {
    lastWhy = 'No PC has Musaned signed in (Morning sign-in)'
    notBefore = Date.now() + RETRY_MS
    return
  }
  runOn(db, pc).then(r => {
    if (finished(r)) { lastDone = Date.now(); lastWhy = ''; console.log(`[contracts] hourly check on ${pc.name}: ${r.checked ?? 0} requests${r.newlyChosen?.length ? `, newly chosen: ${r.newlyChosen.join(', ')}` : ''}`); return }
    lastWhy = r?.why || r?.error || ''
    if (pc.instance !== me) {
      // That PC could not do it: the next one gets its turn in a minute.
      skipUntil.set(pc.instance, Date.now() + RETRY_MS)
      notBefore = Date.now() + 60e3
    } else notBefore = Date.now() + RETRY_MS
    console.log(`[contracts] hourly check on ${pc.name} did not run: ${lastWhy || 'busy'}`)
  }).catch(e => { lastWhy = e.message; notBefore = Date.now() + RETRY_MS })
}

// ── On a Companion ──────────────────────────────────────────────────────────

let serving = false
async function callMain(path, body) {
  const main = mainURL()
  const key = await mainKey().catch(() => '')
  const r = await fetch(`${main}/api/selection-check/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-adal-pc': key } : {}) },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(60000),
  })
  return r.json()
}

async function helloMain() {
  if (!mainURL()) return
  const j = await callMain('hello', { instance: instanceId(), name: myName(), ...powerNow(), musaned: await musanedHere(), browser: await browserHere() }).catch(() => null)
  if (j?.run && !serving) serve(j.run, j.kind).catch(e => console.warn(`[selection-check] reading ${j.kind === 'wafid' ? 'Wafid' : 'Musaned'} failed:`, e.message))
}

/** Wafid's result for one passport, in this PC's Wafid tab (taken the first time). */
async function wafidHere(state, passport) {
  if (!/^[A-Z0-9]{5,15}$/.test(passport)) throw new Error('not a passport number')
  const { checkMedicalStatus, downloadResultPdf } = await import('./wafidWorkflow.js')
  if (!state.page) {
    const { getBrowser } = await import('./browser.js')
    const tm = await import('./tabManager.js')
    state.page = await tm.borrowTab(await getBrowser(), 'wafid_check', new Set())
    await tm.setupTab(state.page, { runId: 'wafid-status' })
    state.page.__adalAllowImages = true // reCAPTCHA
  }
  const r = await checkMedicalStatus(state.page, passport)
  let pdf = ''
  if (r.state === 'fit' || r.state === 'unfit') pdf = (await downloadResultPdf(state.page).catch(() => null))?.toString('base64') || ''
  return { state: r.state, text: r.text, pdf }
}

/** This Companion holds the lease: read Musaned (or Wafid) in its tab, step by step, as the main PC asks. */
async function serve(token, kind = 'musaned') {
  serving = true
  const { openBrowserIfAny } = await import('./browser.js')
  const tm = await import('./tabManager.js')
  const mc = await import('./musanedContracts.js')
  let page = null, backTo = '', H = null, misses = 0
  const wafid = { page: null }
  try {
    if (kind !== 'wafid') {
      const browser = await openBrowserIfAny()
      page = browser ? await tm.borrowOpenTab(browser, 'musaned_check_chosen', new Set()) : null
      if (page && /\/(login|auth)\b|sso\.|wahid\.sa|\/realms\//i.test(page.url())) { await tm.doneWithTab(page).catch(() => {}); page = null }
      if (page) { backTo = page.url(); await tm.setupTab(page, { runId: 'musaned-contracts' }); page.__adalAllowImages = true }
      console.log(`[selection-check] this PC reads Musaned for the main PC${page ? '' : ' — but no free signed-in Musaned tab'}`)
    } else console.log('[wafid-daily] this PC reads Wafid results for the main PC')
    while (misses < 4) {
      const job = await callMain('remote/next', { token }).catch(() => null)
      if (!job) { misses++; await sleep(5000); continue }   // the main PC did not answer
      misses = 0
      if (job.done) break
      if (!job.id) continue
      let out
      try {
        const a = job.args || {}
        if (job.kind === 'wafid') out = { ok: true, result: await wafidHere(wafid, String(a.passport || '').trim().toUpperCase()) }
        else if (job.kind === 'headers') { H = page ? await mc.apiHeadersOf(page) : null; out = { ok: true, result: !!H } }
        else if (!page || !H) throw new Error('Musaned is not signed in on this PC')
        else if (job.kind === 'api') {
          if (!/^\/api\//.test(String(a.url || ''))) throw new Error('not a Musaned address')
          out = { ok: true, result: await mc.apiGet(page, H, String(a.url), { binary: !!a.binary }) }
        } else if (job.kind === 'contract') {
          if (!/^\d+$/.test(String(a.card?.id || ''))) throw new Error('not a contract')
          out = { ok: true, result: await mc.openContract(page, a.card) }
        } else if (job.kind === 'pdf') out = { ok: true, result: (await mc.downloadPdf(page.browser(), page, String(a.name || ''))).toString('base64') }
        else throw new Error(`unknown step ${job.kind}`)
      } catch (e) { out = { ok: false, error: e.message } }
      await callMain('remote/answer', { token, id: job.id, ...out }).catch(() => {})
    }
  } finally {
    if (backTo && page && !page.isClosed?.()) await page.goto(backTo, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await tm.doneWithTab(page).catch(() => {})
    if (wafid.page) await tm.doneWithTab(wafid.page).catch(() => {})
    serving = false
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

let timer = null
export function startSelectionCheck(db) {
  if (timer) return
  const run = () => (isFollower() ? helloMain() : tick(db)).catch(e => console.warn('[selection-check]', e.message))
  // The first check 5 minutes after the start (the tabs are signed in again by then).
  notBefore = Date.now() + 5 * 60e3
  wafidDaily.notBefore = Date.now() + 10 * 60e3
  setTimeout(run, 30000).unref?.()
  timer = setInterval(run, 60000)
  timer.unref?.()
}
