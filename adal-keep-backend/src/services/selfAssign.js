/**
 * selfAssign.js — a robot run chooses the best PC of the office by itself, at its start, in under a second, with
 * nobody asked and nothing to set (the owner, 2026-11-25: "make it assign itself to the best PC as fast as possible,
 * without even consulting anyone … you won't be at every agency"). In every agency. (He had said on 2026-11-24
 * "forget making the robots through LAN": this replaces that, for the robots only; CV PDFs and moves stay here.)
 *
 * Chosen by what makes a run slow (sharePower.estimate): processor left over, cores, memory, battery, internet, what
 * it does already, and where the account is signed in (signInHome: a person's sign-in is not asked again). Only a PC
 * that answers now. Not reachable when the browser is needed → the next best one → this PC (worker.browserForJob).
 * Emergency off switch: ADAL_LAN_ROBOTS=0 — every run on the main PC, as before.
 */
import { ownPower, runningOn, tabsOnPCs, chooseBest, estimate, MIN_HELPER_CORES, lanRobots } from './sharePower.js'
import { peerOf } from './tabManager.js'
import { homeOf } from './signInHome.js'

export const DECIDE_MS = 900
const within = (p, ms, d) => { let t; return Promise.race([Promise.resolve(p).catch(() => d), new Promise(r => { t = setTimeout(() => r(d), ms) })]).finally(() => clearTimeout(t)) }
const label = (p) => (p ? `${p.name || 'a PC'} (${p.cores || 1} cores, ${Math.round(p.mem_gb || 0)} GB${p.load != null ? `, ${Math.round(p.load)} % busy` : ''})` : 'a PC')

export async function selfAssign(db, job, { pcs = null, tabs = null, running = null, home = undefined, now = Date.now, log = () => {} } = {}) {
  let ctx = {}
  try { ctx = JSON.parse(job.context || '{}') } catch {}
  if (!lanRobots() || ctx.placed || ctx.on_main) return ''
  // Sites whose sign-in belongs to one PC stay where they are (2026-11-26): Tasheer keeps one session for the agency
  // (on another PC it would sign this one out), LMIS's codes are typed at the PC that pressed Sign In (lmisOne.js
  // sends a run to where its LMIS is open). ADAL_MOVE_SITES=tasheer,lmis lets them go too.
  const stay = (peerOf(job.workflow_id) || '').match(/^(tasheer|lmis)$/)?.[0]
  if (stay && !String(process.env.ADAL_MOVE_SITES || '').split(',').map(x => x.trim()).includes(stay)) { log(`${stay === 'tasheer' ? 'Tasheer' : 'LMIS'}: stays on the PC its sign-in belongs to`); return '' }
  const t0 = now()
  const from = String(ctx.on_device || '')
  if (!pcs) {
    const rb = await import('./remoteBrowsers.js')
    pcs = [ownPower(), ...await within(rb.askDevices(600), 3400, [])]   // (0.6 s; only when nobody answered, 2.5 s more)
    if (pcs.length < 2 && rb.knownDevices()) log(`${rb.knownDevices()} office PC(s) known, none answers now`)
  }
  pcs = pcs.filter(p => p.id === '' || p.browser !== false)
  if (pcs.length < 2) {
    log('one PC')
    ctx.quiet = 1                         // (out of sight here too; asked again when it is started again)
    job.context = JSON.stringify(ctx)
    const { seal } = await import('./accountVault.js')
    await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
    return ''
  }
  const left = () => Math.max(50, DECIDE_MS - (now() - t0))
  running = running || await within(runningOn(db), left(), {})
  tabs = { ...(tabs || await within(tabsOnPCs(db, job), Math.min(250, left()), {})) }
  const peer = peerOf(job.workflow_id), acct = job.account_id || ctx.account_id
  const at = home !== undefined ? home : homeOf(peer, acct)
  if (at !== null && pcs.some(p => p.id === at)) tabs[at] = { signedIn: true }
  const c = chooseBest({ from, pcs, running, tabs })
  // Where else, should it not be reached: the other able PCs, the fastest first, this PC last.
  const order = pcs.filter(p => p.id !== '' && p.id !== c.to && (Number(p.cores) || 1) >= MIN_HELPER_CORES)
    .map(p => [p.id, estimate(p, { running: running[p.id] || 0, tab: tabs[p.id] || null, remote: true })]).sort((a, b) => a[1] - b[1]).map(x => x[0]).slice(0, 3)
  ctx.placed = 1
  ctx.quiet = 1                           // out of sight, on whatever PC
  ctx.place_order = order
  let line = ''
  if (c.help) {
    const a = pcs.find(p => p.id === from), b = pcs.find(p => p.id === c.to)
    ctx.helped_for = a?.name || 'this PC'
    ctx.helped_by = b?.name || 'another PC'
    if (c.to) ctx.on_device = c.to; else delete ctx.on_device
    line = `${label(b)} does this run by itself, out of sight there: about ${Math.round(c.secs[c.to])} s there, ${Math.round(c.secs[from])} s on ${label(a)} (${c.why}) — chosen in ${now() - t0} ms`
  }
  job.context = JSON.stringify(ctx)
  const { seal } = await import('./accountVault.js')
  await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
  return line
}
