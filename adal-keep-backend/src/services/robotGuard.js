/**
 * robotGuard.js — no robot tab holds this PC.
 *
 * 2026-11-25, an agency's main PC (2 cores): one robot tab ("[NUZLA]", about:blank) had its page loop at 98 % of a
 * core for hours. The fix of that loop (robotCheck.LABEL_IN_PAGE) did not stop it: the old script went on living in
 * the open tab after the server was updated and started again. So the robot browser itself is looked at:
 *
 *   every 20 s  one question to the browser: how much processor did each page process use (nothing is asked of the
 *               pages themselves). Only when one is over 60 % of a core are the tabs asked which one it is — a tab
 *               that does not answer is that one.
 *               (Over 35 % when the whole PC is over 90 % busy: a loop gets only its share then.)
 *   over 60 % for 60 s, and no run progressing in it:
 *               a tab with a form, a run or a person in it is NEVER closed or loaded again: the running script is
 *               ended (the form stays); still busy → slowed to a fifth (its scripts paused 0.8 s of every second),
 *               full speed again the moment a person opens it or a run goes on; its process gets the lowest priority.
 *               a tab with none of these: its script ended → loaded again → emptied → closed.
 *   at start and every look: an empty labelled tab ("[name]", about:blank) no run owns is closed.
 *   over MAX_TABS tabs: the oldest robot tabs nobody needs are closed.
 *
 * What was measured (2026-11-25, Chrome): a page looping in its own microtasks answers no new session; ending its
 * script works only through a session from before (puppeteer's own); loading it again, navigating it and crashing it
 * do nothing; closing the target and killing its process work. CPU throttling (Emulation.setCPUThrottlingRate) burns
 * the processor it takes away, and "frozen" does nothing to a visible page: neither is used.
 *
 * ADAL_ROBOT_GUARD=0 turns it off. Never starts a browser, never shows a window. Every act: a "[guard]" line, counted.
 */
import os from 'os'
import { openBrowserIfAny } from './browser.js'
import { tabOfRun, runsWithTabs } from './tabManager.js'
import { isWatched } from './liveFrames.js'

const LOOK_MS = 20000
export const HOT = 0.6                 // of one core
const HOT_FULL_PC = 0.35               // … when the whole PC is over 90 % busy (a loop gets only its share of it)
export const HOT_FOR_MS = 60000
const PROGRESS_MS = 60000              // a run that logged a step in this time is progressing
export const MAX_TABS = 12
const ANCHOR = 'adal-agents-window'    // browser.js: the runs' window is opened from this blank tab
const LIVE = ['running', 'paused', 'pending']

export const counts = { looks: 0, hot: 0, ended: 0, reloaded: 0, emptied: 0, slowed: 0, woken: 0, closed: 0, orphans: 0, over: 0, prio: 0 }
const total = () => counts.ended + counts.reloaded + counts.emptied + counts.slowed + counts.closed + counts.orphans + counts.over
const say = (what) => console.log(`[guard] ${what} (${total()} act${total() === 1 ? '' : 's'} since the start)`)

const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }
const LABELLED = /^\[[^\]]+\]/

/**
 * What to do with one hot tab. tab: { hotMs, url, stuck, watched, ours, only, anchor, held, progressing, level }
 *   held: a run, a person or a filled form is in it (or it cannot be asked, so there may be).
 *   level: how many acts it had already since it got hot.
 */
export function decide(tab) {
  if (tab.hotMs < HOT_FOR_MS) return 'none'
  if (!tab.ours) return 'priority'                       // a person's own tab: only its priority
  if (tab.progressing) return 'none'
  if (tab.held) {
    if (tab.level === 0) return 'end'
    if (tab.watched) return 'priority'                   // a person works in it now: never slowed under their hand
    return 'slow'
  }
  // Nothing in it. (An empty page has no script of its own worth keeping; the last tab would close the browser.)
  if (tab.url === 'about:blank' && !tab.only) return 'close'
  return ['end', 'reload', 'empty'][tab.level] || (tab.only ? 'priority' : 'close')
}

/** Is this an empty tab an earlier run (or an earlier server) left behind? */
export const isOrphan = (t) => t.url === 'about:blank' && LABELLED.test(t.title || '') && !t.owned && !t.inUse && !t.only

// --------------------------------------------------------------------------
// The browser
// --------------------------------------------------------------------------
let _cdp = null, _cdpOf = null
async function browserSession(browser) {
  if (_cdp && _cdpOf === browser && _cdp.connection?.()) return _cdp
  _cdpOf = browser
  _cdp = await within(browser.target().createCDPSession(), 5000)
  return _cdp
}

/** The processor each process of the browser used so far (seconds), by its number. */
async function cpuTimes(cdp) {
  const r = await within(cdp.send('SystemInfo.getProcessInfo'), 5000)
  return new Map((r?.processInfo || []).filter(p => p.type === 'renderer').map(p => [p.id, p.cpuTime]))
}

const pcTimes = () => os.cpus().reduce((a, c) => { const v = Object.values(c.times); a.all += v.reduce((x, y) => x + y, 0); a.idle += c.times.idle; return a }, { all: 0, idle: 0 })
/** The session puppeteer has had with this page since it opened: the one a looping page still hears. */
const ownSession = (page) => { try { return page._client?.() || page.mainFrame?.().client || null } catch { return null } }

/** The tabs as the browser told of each change (puppeteer keeps them): nothing is asked. Asked only if that is not there. */
async function infosOf(browser, cdp) {
  try {
    const known = browser.targets().map(t => t._getTargetInfo?.()).filter(Boolean)
    if (known.length) return known.filter(t => t.type === 'page')
  } catch {}
  return ((await within(cdp.send('Target.getTargets'), 5000))?.targetInfos || []).filter(t => t.type === 'page')
}

async function tabsOf(browser, cdp) {
  const infos = (await infosOf(browser, cdp)).filter(t => !/^(devtools|chrome-extension):/.test(t.url))
  const pages = new Map()
  // A looping tab of before a restart never attaches: it stays without a page (4 s for all of them together).
  await Promise.all(browser.targets().filter(t => t.type() === 'page').map(async t => { const p = await within(t.page(), 4000); if (p) pages.set(t._targetId, p) }))
  const owner = new Map(runsWithTabs().map(id => [tabOfRun(id), Number(id)]))
  return infos.map(t => {
    const page = pages.get(t.targetId) || null
    return {
      id: t.targetId, url: t.url, title: t.title, page, run: page ? owner.get(page) ?? null : null,
      owned: page ? owner.has(page) : false,
      inUse: !!(page && (page.__adalBorrowed || page.__adalPerson || page.__adalStandbyAt || (page.__adalRunId !== undefined && !Number.isFinite(Number(page.__adalRunId))))),
      only: infos.length < 2,
    }
  })
}

// In the page: what is in it.
const CONTENT = () => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const boxes = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
    .filter(e => !['hidden', 'submit', 'button', 'search'].includes(e.type) && seen(e))
  return {
    name: window.name,
    form: boxes.some(e => e.type === 'password' || e.type === 'file' || (e.type === 'checkbox' || e.type === 'radio' ? e.checked !== e.defaultChecked : e.isContentEditable ? (e.textContent || '').trim() : e.tagName !== 'SELECT' && e.value))
      || !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]') || boxes.length > 3,
    touched: (() => { try { return Number(sessionStorage.getItem('adal-touched')) || 0 } catch { return 0 } })(),
  }
}

/** How busy a tab's own pages (and the frames of other sites in it) are: of a core, over `ms`. null = no answer. */
async function busyOf(page, ms = 1500) {
  let sessions = []
  try { sessions = [...new Set(page.frames().map(f => f.client).filter(Boolean))] } catch {}
  if (!sessions.length) { const s = ownSession(page); if (s) sessions = [s] }
  const sample = (s) => within((async () => {
    await s.send('Performance.enable')
    const { metrics } = await s.send('Performance.getMetrics')
    return metrics.find(m => m.name === 'TaskDuration')?.value ?? 0
  })(), 4000)
  const a = await Promise.all(sessions.map(sample)), t0 = Date.now()
  if (a.some(x => x === null)) return null
  await new Promise(r => setTimeout(r, ms))
  const b = await Promise.all(sessions.map(sample))
  const el = (Date.now() - t0) / 1000
  for (const s of sessions) within(s.send('Performance.disable'), 1000)
  if (b.some(x => x === null)) return null
  return Math.max(0, ...b.map((x, i) => (x - a[i]) / el))
}

/** The script running in the page now ends (the page and what is typed in it stay); ours of an older version go. */
async function endScript(page) {
  const s = ownSession(page)
  if (!s) return false
  if (await within(s.send('Runtime.terminateExecution').then(() => true), 4000, false) !== true) return false
  await within(page.evaluate(() => {
    try { window.__adalLabelObs?.disconnect(); window.__adalLabelObs = null } catch {}
    try { if (typeof window.__adalAlreadyWatch === 'number') { clearInterval(window.__adalAlreadyWatch); window.__adalAlreadyWatch = null } } catch {}
  }), 3000)
  return true
}

const _slow = new Map()   // page → { cdp, on }
/** The page's scripts run 1 fifth of the time. It still answers, later; woken by page.__adalWake(). */
async function slow(page, why) {
  if (_slow.has(page)) return true
  const cdp = await within(page.createCDPSession(), 3000)
  if (!cdp || !(await within(cdp.send('Debugger.enable').then(() => true), 3000, false))) { within(cdp?.detach?.(), 1000); return false }
  const st = { cdp, on: true }
  _slow.set(page, st)
  // (A paused page asks for nothing but "go on": its own debugger statements too.)
  ;(async () => {
    while (st.on) {
      await cdp.send('Debugger.pause').catch(() => { st.on = false })
      await new Promise(r => setTimeout(r, 800))
      await cdp.send('Debugger.resume').catch(() => {})
      if (st.on) await new Promise(r => setTimeout(r, 200))
    }
    within(cdp.send('Debugger.disable').catch(() => {}).then(() => cdp.detach()), 2000)
    _slow.delete(page)
  })()
  page.__adalWake = async (who = 'a person or a run needs it') => {
    if (!st.on) return
    st.on = false
    page.__adalWake = null
    counts.woken++
    await within(cdp.send('Debugger.disable'), 1500)
    say(`"${why}" at full speed again: ${who}`)
  }
  return true
}

const prioritised = new Set()
/** The process behind it comes after everything else on this PC. */
function lowest(pid) {
  if (!pid || prioritised.has(pid)) return false
  try { os.setPriority(pid, os.constants.priority.PRIORITY_LOW); prioritised.add(pid); counts.prio++; return true } catch { return false }
}

async function note(db, runId, msg) {
  if (!db || !runId) return
  try {
    const row = await db('automation_queue').where('id', runId).first('log')
    let log = []
    try { log = JSON.parse(row?.log || '[]') } catch {}
    log.push({ ts: Date.now(), level: 'warn', msg })
    await db('automation_queue').where('id', runId).update({ log: JSON.stringify(log.slice(-200)) })
  } catch {}
}

async function runRow(db, id) {
  if (!db || !id) return null
  return db('automation_queue').where('id', id).first('id', 'status', 'pause_reason', 'log').catch(() => null)
}
const lastStep = (row) => { try { const l = JSON.parse(row?.log || '[]'); return Number(l[l.length - 1]?.ts) || 0 } catch { return 0 } }

// --------------------------------------------------------------------------
// The look
// --------------------------------------------------------------------------
let _prev = null                 // { at, cpu: Map pid → seconds, browser }
const _hotPid = new Map()        // pid → since
const _tab = new Map()           // target id → { since, level, at }
const _blank = new Map()         // orphan target id → first seen

/** One look. Returns what was done: [{ act, title, url, run }]. */
export async function guardLook(browser, db, { now = Date.now(), hotFor = HOT_FOR_MS, orphanMs = 60000, maxTabs = MAX_TABS, atStart = false, hotAt = null } = {}) {
  const done = []
  const cdp = await browserSession(browser)
  if (!cdp) return done
  counts.looks++
  const act = (what, t, line) => { done.push({ act: what, title: t?.title, url: t?.url, run: t?.run }); say(line) }
  const closeTarget = (t) => within(cdp.send('Target.closeTarget', { targetId: t.id }).then(() => true), 5000, false)

  // Empty labelled tabs nobody owns, and too many tabs (asked of the browser, not of the pages).
  const infos = await infosOf(browser, cdp)
  const blanks = infos.filter(t => t.url === 'about:blank' && LABELLED.test(t.title || ''))
  for (const id of [..._blank.keys()]) if (!blanks.some(t => t.targetId === id)) _blank.delete(id)
  for (const t of blanks) if (!_blank.has(t.targetId)) _blank.set(t.targetId, now)
  if (blanks.some(t => atStart || now - _blank.get(t.targetId) >= orphanMs)) {
    for (const t of (await tabsOf(browser, cdp)).filter(isOrphan)) {
      if (!atStart && now - (_blank.get(t.id) ?? now) < orphanMs) continue
      if (!(await closeTarget(t))) continue
      counts.orphans++; _blank.delete(t.id); _tab.delete(t.id)
      act('orphan', t, `an empty tab left by an earlier run closed: "${t.title}"`)
    }
  }
  if (infos.length > maxTabs) {
    let over = infos.length - maxTabs
    for (const t of await tabsOf(browser, cdp)) {   // (as they were opened: the oldest first)
      if (over <= 0) break
      if (!t.page || t.owned || t.inUse || isWatched(t.page)) continue
      const c = await within(t.page.evaluate(CONTENT), 2000)
      if (!c || c.form || c.name === ANCHOR || now - c.touched < 30 * 60000) continue
      const run = /^adal-run-(\d+)$/.exec(c.name || '')?.[1]
      if (!run && !t.page.__adalCdp) continue        // a person's own
      if (run && LIVE.includes((await runRow(db, Number(run)))?.status)) continue
      if (!(await closeTarget(t))) continue
      over--; counts.over++
      act('over', t, `${infos.length} tabs open (${maxTabs} at most): "${t.title || t.url}" of a finished run closed`)
    }
  }

  // Which page processes are busy?
  const cpu = await cpuTimes(cdp)
  const prev = _prev?.browser === browser ? _prev : null
  _prev = { at: now, cpu, browser }
  const pc = pcTimes()
  const pcBusy = prev?.pc && pc.all > prev.pc.all ? 1 - (pc.idle - prev.pc.idle) / (pc.all - prev.pc.all) : 0
  _prev.pc = pc
  const limit = hotAt ?? (pcBusy > 0.9 ? HOT_FULL_PC : HOT)
  const hotPids = []
  for (const [pid, s] of cpu) {
    const used = prev?.cpu.has(pid) ? (s - prev.cpu.get(pid)) / Math.max(1, (now - prev.at) / 1000) : 0
    if (used >= limit) { if (!_hotPid.has(pid)) _hotPid.set(pid, prev.at); hotPids.push(pid) } else _hotPid.delete(pid)
  }
  for (const pid of [..._hotPid.keys()]) if (!cpu.has(pid)) _hotPid.delete(pid)
  for (const pid of [...prioritised]) if (!cpu.has(pid)) prioritised.delete(pid)
  if (!hotPids.length) {
    // Cool again for 5 minutes: forgotten. (A slowed tab stays slowed: it is cool because it is slowed.)
    for (const [id, st] of _tab) if (now - st.at > 5 * 60000) _tab.delete(id)
    return done
  }
  const ripe = hotPids.filter(pid => now - _hotPid.get(pid) >= hotFor)
  if (!ripe.length) return done
  counts.hot++

  // Which tabs are they? One that does not answer, or is busy itself.
  const tabs = await tabsOf(browser, cdp)
  const busy = await Promise.all(tabs.map(async t => (t.page ? busyOf(t.page) : null)))
  const seen = tabs.map((t, i) => ({ ...t, busy: busy[i], stuck: busy[i] === null })).filter(t => !_slow.has(t.page))
  let hot = seen.filter(t => t.stuck || t.busy >= limit)
  if (!hot.length) hot = seen.filter(t => t.busy >= limit / 2).sort((x, y) => y.busy - x.busy).slice(0, 1)
  if (!hot.length) {
    for (const pid of ripe) if (lowest(pid)) act('priority', null, `a page process (${pid}) is busy and no tab of it is — it comes after everything else now`)
    return done
  }
  for (const t of hot) {
    const st = _tab.get(t.id) || { since: Math.min(...ripe.map(p => _hotPid.get(p))), level: 0, at: now }
    if (now - st.at > 5 * 60000) { st.level = 0; st.since = Math.min(...ripe.map(p => _hotPid.get(p))) }
    st.at = now
    _tab.set(t.id, st)
    const c = t.page && !t.stuck ? await within(t.page.evaluate(CONTENT), 2000) : null
    const named = /^adal-run-(\d+)$/.exec(c?.name || '')?.[1]
    const runId = t.run ?? (named ? Number(named) : null)
    const row = await runRow(db, runId)
    const live = !!row && LIVE.includes(row.status)
    // A tab that cannot be asked may hold a form: it counts as held, unless it is an empty page.
    const held = live || t.inUse || (t.url !== 'about:blank' && (t.stuck || !c || c.form || now - (c?.touched || 0) < 30 * 60000))
    const ours = !!(t.page?.__adalCdp || named || runId !== null || LABELLED.test(t.title || '')) && !/^https?:\/\/(localhost|127\.0\.0\.1):(4000|4001|4010)\b/.test(t.url)
    const what = decide({
      hotMs: now - st.since >= hotFor ? HOT_FOR_MS : 0, url: t.url, stuck: t.stuck, ours, held, level: st.level,
      only: t.only || c?.name === ANCHOR, watched: !!t.page && isWatched(t.page),
      progressing: row?.status === 'running' && now - lastStep(row) < PROGRESS_MS,
    })
    const name = `${t.title || t.url}`.slice(0, 80), who = runId ? ` (run #${runId}, ${row?.status || 'gone'})` : ''
    const how = t.stuck ? 'it answers nothing' : `${Math.round(t.busy * 100)} % of a core`
    if (what === 'none') continue
    st.level++
    const mine = ripe.length === 1 || hot.length === 1 ? ripe : []
    let left = what
    if (left === 'end') {
      if (t.page && await endScript(t.page)) { counts.ended++; act('end', { ...t, run: runId }, `"${name}"${who}: ${how} for over a minute — the script it was running is ended, its page stays as it is`); continue }
      left = held ? 'slow' : 'close'                  // it hears nothing (a tab from before a restart)
      if (left === 'close' && t.only) left = 'priority'
    }
    if (left === 'reload') {
      if (t.page && !t.stuck && await within(t.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => true), 16000, false)) { counts.reloaded++; act('reload', t, `"${name}"${who}: ${how}, no form in it — loaded again`); continue }
      left = t.only ? 'priority' : 'close'
    }
    if (left === 'empty') {
      if (t.page && !t.stuck && await within(t.page.goto('about:blank', { timeout: 10000 }).then(() => true), 11000, false)) { counts.emptied++; act('empty', t, `"${name}"${who}: ${how} also after it was loaded again — emptied`); continue }
      left = t.only ? 'priority' : 'close'
    }
    if (left === 'close') {
      if (await closeTarget(t)) { counts.closed++; _tab.delete(t.id); act('close', t, `"${name}"${who}: ${how} for over a minute, nothing in it — closed`) }
      continue
    }
    if (left === 'slow') {
      const ok = t.page && !t.stuck && await slow(t.page, name)
      const low = mine.filter(lowest).length
      if (ok) { counts.slowed++; act('slow', { ...t, run: runId }, `"${name}"${who}: ${how}, something is open in it — never closed: slowed to a fifth until a person opens it or its run goes on`) }
      else if (low) act('priority', { ...t, run: runId }, `"${name}"${who}: ${how}, something may be open in it — never closed: it comes after everything else on this PC`)
      if (ok || low) await note(db, runId, `⚠ This run's page used ${t.stuck ? 'the processor without end and does not answer' : how} — kept open, ${ok ? 'slowed down until somebody opens it' : 'after everything else on this PC; press Stop, then start it again'}`)
      continue
    }
    if (left === 'priority') { const n = mine.filter(lowest).length; if (n) act('priority', t, `"${name}"${who}: ${how} — it comes after everything else on this PC`) }
  }
  return done
}

/** Its state, for support. */
export const guardState = () => ({ ...counts, slowedNow: _slow.size })
export const _resetGuardForTest = () => { _prev = null; _hotPid.clear(); _tab.clear(); _blank.clear(); prioritised.clear(); _cdp = null; for (const k of Object.keys(counts)) counts[k] = 0 }

let timer = null
export function startRobotGuard(db) {
  if (timer || process.env.ADAL_ROBOT_GUARD === '0' || process.env.NODE_TEST_CONTEXT) return
  let busy = false, first = true
  const look = async () => {
    if (busy) return
    busy = true
    try {
      const browser = await openBrowserIfAny()
      if (browser) { await guardLook(browser, db, { atStart: first }); first = false }
    } catch (e) { console.warn('[guard]', e.message) } finally { busy = false }
  }
  setTimeout(look, 10000).unref?.()
  timer = setInterval(look, LOOK_MS)
  timer.unref?.()
  console.log(`[guard] robot tabs watched every ${LOOK_MS / 1000} s: over ${HOT * 100} % of a core for ${HOT_FOR_MS / 1000} s is stopped`)
}
