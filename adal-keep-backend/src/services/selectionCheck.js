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
 */
import os from 'os'
import crypto from 'crypto'
import { mainURL, mainKey, instanceId, isFollower } from './mainPC.js'

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
 * one that checked last time, else any (the first).
 */
export function pickLeader(list, last = '') {
  const gb = (p) => Math.floor((Number(p.free_mb) || 0) / 1024)
  const ok = list.filter(p => p && p.musaned)
  ok.sort((a, b) => ((Number(b.cores) || 0) - (Number(a.cores) || 0)) || (gb(b) - gb(a)) || ((b.instance === last) - (a.instance === last)))
  return ok[0] || null
}

// ── On the main PC ──────────────────────────────────────────────────────────

const pcs = new Map()              // instance → { instance, name, cores, free_mb, musaned, at }
export const lease = { holder: '', name: '', token: '', until: 0, manual: false }
const skipUntil = new Map()        // a PC that did not take its turn: passed over for a while
let lastDone = 0, notBefore = 0, lastLeader = '', lastWhy = ''
let remote = null                  // the steps waiting for the Companion that holds the lease

function selfPc(musaned = false) {
  return { instance: instanceId(), name: myName(), ...powerNow(), musaned, at: Date.now(), main: true }
}

/** A Companion says it is here (every minute). Its turn → the lease's token. */
export function hello(info = {}) {
  const instance = String(info.instance || '').slice(0, 40)
  if (!instance || instance === instanceId()) return { error: 'no instance' }
  pcs.set(instance, {
    instance, name: String(info.name || 'A Companion PC').slice(0, 80),
    cores: Number(info.cores) || 1, free_mb: Number(info.free_mb) || 0, musaned: !!info.musaned, at: Date.now(),
  })
  if (lease.holder === instance && lease.token && remote?.token === lease.token) {
    lease.until = Date.now() + LEASE_MS
    return { run: lease.token }
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
  const mc = await import('./musanedContracts.js')
  const token = crypto.randomBytes(12).toString('hex')
  Object.assign(lease, { holder: pc.instance, name: pc.name, token, until: Date.now() + LEASE_MS, manual })
  lastLeader = pc.instance
  const limitMs = manual ? MANUAL_LIMIT_MS : AUTO_LIMIT_MS
  try {
    if (pc.instance === instanceId()) return await mc.scanContracts(db, { auto: !manual, limitMs, by: pc.name })
    console.log(`[selection-check] ${pc.name} checks Musaned (${pc.cores} cores, ${Math.round(pc.free_mb / 1024)} GB free)`)
    return await mc.scanContracts(db, { auto: true, limitMs, by: pc.name, remote: remoteSource(token, pc.name, mc.cancelable) })
  } finally {
    if (lease.token === token) Object.assign(lease, { holder: '', name: '', token: '', until: 0, manual: false })
    if (remote?.token === token) remote = null
  }
}

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
  }
}

async function tick(db) {
  const { contractCheck, cancelCheck } = await import('./musanedContracts.js')
  const me = instanceId()
  pcs.set(me, selfPc(await musanedHere()))
  for (const [k, p] of pcs) if (Date.now() - p.at > SEEN_MS) pcs.delete(k)
  // The checking PC stopped answering: its lease ends, the next PC takes over.
  if (lease.token && lease.holder !== me && Date.now() > lease.until) {
    console.warn(`[selection-check] ${lease.name} went away — another PC takes over`)
    skipUntil.set(lease.holder, Date.now() + 10 * 60e3)
    cancelCheck(`${lease.name} went away`)
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
  const j = await callMain('hello', { instance: instanceId(), name: myName(), ...powerNow(), musaned: await musanedHere() }).catch(() => null)
  if (j?.run && !serving) serve(j.run).catch(e => console.warn('[selection-check] reading Musaned failed:', e.message))
}

/** This Companion holds the lease: read Musaned in its tab, step by step, as the main PC asks. */
async function serve(token) {
  serving = true
  const { openBrowserIfAny } = await import('./browser.js')
  const tm = await import('./tabManager.js')
  const mc = await import('./musanedContracts.js')
  let page = null, backTo = '', H = null, misses = 0
  try {
    const browser = await openBrowserIfAny()
    page = browser ? await tm.borrowOpenTab(browser, 'musaned_check_chosen', new Set()) : null
    if (page && /\/(login|auth)\b|sso\.|wahid\.sa|\/realms\//i.test(page.url())) { await tm.doneWithTab(page).catch(() => {}); page = null }
    if (page) { backTo = page.url(); await tm.setupTab(page, { runId: 'musaned-contracts' }); page.__adalAllowImages = true }
    console.log(`[selection-check] this PC reads Musaned for the main PC${page ? '' : ' — but no free signed-in Musaned tab'}`)
    while (misses < 4) {
      const job = await callMain('remote/next', { token }).catch(() => null)
      if (!job) { misses++; await sleep(5000); continue }   // the main PC did not answer
      misses = 0
      if (job.done) break
      if (!job.id) continue
      let out
      try {
        const a = job.args || {}
        if (job.kind === 'headers') { H = page ? await mc.apiHeadersOf(page) : null; out = { ok: true, result: !!H } }
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
  setTimeout(run, 30000).unref?.()
  timer = setInterval(run, 60000)
  timer.unref?.()
}
