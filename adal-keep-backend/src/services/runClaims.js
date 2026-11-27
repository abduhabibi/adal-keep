/**
 * runClaims.js — one run per girl and site across all the agency's PCs (the owner,
 * 2026-11-27: "the robot brain runs on every PC, and Main can be off").
 *
 * Before a run starts, worker.js asks claimRun(db, job). The claim is a lease of 60 s with
 * this PC's identity, renewed every 20 s until releaseRun(db, job, result):
 *   1. The office network first: every other PC of the agency that answers must agree
 *      (POST /api/sync/claim, with the sync's own key or certificate). One that says another
 *      PC holds that girl and site → no.
 *   2. A PC that does not answer → the online copy too: add-only files
 *      <agency>/claims/<key hash>/<ms>-<pc id>-<op>-<run id> (a Companion may only add files
 *      there). They are put in order by the server's own time, never a PC's clock: the
 *      earliest live "try" wins; a lease not renewed for 90 s (server time) is dead.
 *   3. Neither → only a row queued on this PC (the id's last 3 digits are its sync slot).
 * A row queued on another PC that cannot be reached is taken only after that PC has been
 * unseen on the office network for 5 minutes (it may be running its own rows, cut off).
 * A done run is remembered 15 minutes, so no PC whose copy still says "pending" starts it.
 * A lease that ran out while its row still says running here: the run is failed,
 * "stopped — PC went away" (one agent, one try: nothing starts it again by itself).
 * Results go back by the companion-full sync (automation_queue, run_history, uploads/).
 * Off: ADAL_ROBOTS_EVERYWHERE=0 — every claim is granted, as before.
 */
import crypto from 'crypto'
import os from 'os'
import { blockedPeer } from './peerBlock.js'

export const claimsOn = (env = process.env) => env.ADAL_ROBOTS_EVERYWHERE !== '0'
export const GRACE_MS = 30_000, SWEEP_MS = 15_000
export const LEASE_MS = 60_000, RENEW_MS = 20_000, DONE_MS = 15 * 60_000, AWAY_MS = 5 * 60_000, ONLINE_DEAD_MS = 90_000
const GONE = 'stopped — PC went away'

// The site of a kind of run (the same groups as tabManager's RUN_PEERS).
const SITES = [[/^musaned/, 'musaned'], [/^(mofa|visa)/, 'mofa'], [/^wafid/, 'wafid'], [/^insurance/, 'insurance'], [/^tasheer/, 'tasheer'],
  [/^(police|lmis|contract_import|delete_labour)/, 'lmis'], [/^enjazplus/, 'enjazplus'], [/^pextran/, 'pextran']]
export const siteOf = (workflowId) => { const w = String(workflowId || '').toLowerCase(); return SITES.find(([re]) => re.test(w))?.[1] || w.split(/[_-]/)[0] || 'other' }
export const keyOf = (job) => `${siteOf(job.workflow_id)}|${job.profile_id}`

// ------------------------------------------------------------ this PC --
let deps = null
/** Where this PC and the others are (replaced in tests). */
async function env() {
  if (deps) return deps
  const S = await import('./sync/index.js').catch(() => null)
  const I = await import('./sync/identity.js').catch(() => null)
  const ids = await import('./sync/ids.js').catch(() => null)
  const node = S?.syncNode?.() || null
  return {
    me: { pc_id: I?.pcId?.() || os.hostname(), pc_name: os.hostname().slice(0, 60) },
    node,
    store: node?.relay?.store ? onlineStore(node.relay.store) : null,
    slot: () => ids?.currentSlot?.() ?? 0,
    isMain: () => S?.isMainRole?.() !== false,
    now: () => Date.now(),
  }
}
export const _setEnvForTests = (d) => { deps = d; leases.clear(); done.clear(); for (const t of timers.values()) clearInterval(t); timers.clear() }

/** A row queued on this PC: its id's last 3 digits are this PC's slot (an old id: the main PC's). */
export function queuedHere(row, slot, isMain = true) {
  const id = Number(row?.id)
  if (!(id >= 1e15)) return !!isMain
  return id % 1000 === Number(slot)
}

// ---------------------------------------------------------- the leases --
const leases = new Map()   // key → { key, run_id, profile_id, workflow_id, pc_id, pc_name, until, since, via, mine }
const done = new Map()     // run id → until
const timers = new Map()   // run id → renew timer

function alive(key, now) {
  const l = leases.get(key)
  if (l && l.until > now) return l
  return null
}

/** Another PC asks (POST /api/sync/claim): try, renew, release. Its clock is never used. */
export function peerClaim(body = {}, peer = {}) {
  const now = (deps?.now || Date.now)()
  const { op, key, run_id } = body
  const pc_id = String(peer.pc_id || body.pc_id || ''), pc_name = String(body.pc_name || peer.name || pc_id).slice(0, 60)
  if (!key || !pc_id) return { granted: false, why: 'no key' }
  if (op === 'release') {
    const l = leases.get(key)
    if (l && l.pc_id === pc_id) leases.delete(key)
    if (body.outcome === 'done' && run_id) done.set(Number(run_id), now + DONE_MS)
    return { ok: true }
  }
  if (run_id && (done.get(Number(run_id)) || 0) > now) return { granted: false, why: 'done already', holder: null }
  const l = alive(key, now)
  // Both asking at the same moment: the lower PC id goes first, the other gives way.
  if (l && l.mine && l.asking && op === 'try' && pc_id < l.pc_id) { l.lost = true; leases.delete(key) }
  else if (l && l.pc_id !== pc_id) return { granted: false, holder: { pc_id: l.pc_id, pc_name: l.pc_name }, why: `${l.pc_name} is doing it` }
  if (op === 'renew' && l && l.pc_id === pc_id) { l.until = now + LEASE_MS; return { granted: true } }
  leases.set(key, { key, run_id: Number(run_id) || null, profile_id: body.profile_id ?? null, workflow_id: body.workflow_id || null, pc_id, pc_name, until: now + LEASE_MS, since: (l && !l.mine && l.since) || new Date(now).toISOString(), via: 'lan', mine: false })
  return { granted: true }
}

/** Asks one PC on the office network: { granted } | { granted: false, holder } | { away: true }. */
async function askPeer(node, pc, body) {
  try {
    if (blockedPeer(pc.pc_id)) return { away: true, pc, error: 'cut (ADAL_BLOCK_PEERS)' }
    let url = node.peerState?.get(pc.pc_id)?.ok ? node.peerState.get(pc.pc_id).url : null
    if (!url) url = await Promise.race([node.reach(pc), new Promise(r => setTimeout(() => r(null), 5000))])
    if (!url || blockedPeer(url)) return { away: true, pc }
    return { ...(await node.call(url, 'POST', '/claim', body, { timeout: 4000 })), pc }
  } catch (e) { return { away: true, pc, error: e.message } }
}

// ------------------------------------------------------- the online copy --
const hashOf = (key) => crypto.createHash('sha256').update('adal-claim|' + key).digest('hex').slice(0, 24)
/** The relay's store with what claims need: add a file, list with the server's times, remove old ones. */
export function onlineStore(store) {
  const sb = typeof store?.headers === 'function' && store.url
  return {
    put: (p, buf) => store.put(p, buf),
    async list(prefix) {
      if (!sb) {
        const { default: fs } = await import('fs'), { default: path } = await import('path')
        return (await store.list(prefix)).map(name => { let at = 0; try { at = fs.statSync(path.join(store.dir, prefix, name)).mtimeMs } catch {} return { name, at } })
      }
      const r = await store.f(`${store.url}/storage/v1/object/list/keep`, { method: 'POST', headers: await store.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: `${store.agency}/${prefix}/`, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }), signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error(`online copy: ${r.status}`)
      return (await r.json()).map(o => ({ name: o.name, at: Date.parse(o.created_at || o.updated_at) || 0 }))
    },
    async remove(paths) {
      if (!sb || !paths.length) return
      await store.f(`${store.url}/storage/v1/object/keep`, { method: 'DELETE', headers: await store.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths.map(p => `${store.agency}/${p}`) }), signal: AbortSignal.timeout(15000) }).catch(() => {})
    },
  }
}
const nameOf = (n) => { const m = String(n).match(/^(\d+)-(.+)-(try|renew|release|done)-(\d*)$/); return m ? { ms: Number(m[1]), pc: m[2], op: m[3], run: Number(m[4]) || null } : null }

/**
 * One step online: op written, then the folder read back. try → { ok } | { ok: false, holder } ;
 * any error → { down: true }.
 */
export async function onlineStep(E, key, op, run_id) {
  if (!E.store) return { down: true }
  const dir = `claims/${hashOf(key)}`
  const file = `${E.now()}-${E.me.pc_id}-${op}-${run_id || ''}`
  try {
    await E.store.put(`${dir}/${file}`, Buffer.from(JSON.stringify({ pc_name: E.me.pc_name })))
    if (op !== 'try') return { ok: true }
    const items = (await E.store.list(dir)).map(i => ({ ...i, ...nameOf(i.name) })).filter(i => i.op)
    const mine = items.find(i => i.name === file)
    const serverNow = mine?.at || Math.max(0, ...items.map(i => i.at))
    // Old files of this folder: the main PC clears them (a Companion may only add).
    if (E.isMain()) E.store.remove(items.filter(i => serverNow - i.at > 86400e3).map(i => `${dir}/${i.name}`)).catch?.(() => {})
    if (run_id && items.some(i => i.op === 'done' && i.run === Number(run_id) && serverNow - i.at < DONE_MS)) return { ok: false, holder: null, why: 'done already' }
    // Each PC's streak: its last release, then its tries/renews after it.
    const byPc = new Map()
    for (const i of items.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))) {
      const s = byPc.get(i.pc) || { start: null, last: 0, startName: '' }
      if (i.op === 'release' || i.op === 'done') { s.start = null; s.last = i.at }
      else { if (s.start == null) { s.start = i.at; s.startName = i.name } s.last = i.at }
      byPc.set(i.pc, s)
    }
    const live = [...byPc.entries()].filter(([, s]) => s.start != null && serverNow - s.last < ONLINE_DEAD_MS)
      .sort((a, b) => a[1].start - b[1].start || a[1].startName.localeCompare(b[1].startName))
    const first = live[0]
    if (!first || first[0] === E.me.pc_id) return { ok: true }
    await E.store.put(`${dir}/${E.now()}-${E.me.pc_id}-release-${run_id || ''}`, Buffer.from('{}')).catch(() => {})
    const name = E.node?.peerByPcId?.(first[0])?.name || E.node?.pcRows?.get?.(first[0])?.name || first[0]
    return { ok: false, holder: { pc_id: first[0], pc_name: name } }
  } catch (e) { return { down: true, error: e.message } }
}

/** That PC renewed this key online lately (server time)? Not knowable → no. */
async function onlineAlive(E, key, pcId) {
  if (!E.store) return false
  try {
    const items = (await E.store.list(`claims/${hashOf(key)}`)).map(i => ({ ...i, ...nameOf(i.name) })).filter(i => i.op)
    const newest = Math.max(0, ...items.map(i => i.at))
    const his = items.filter(i => i.pc === pcId).sort((a, b) => b.at - a.at)[0]
    return !!his && (his.op === 'try' || his.op === 'renew') && newest - his.at < ONLINE_DEAD_MS && Date.now() - newest < 10 * 60_000
  } catch { return false }
}

// ------------------------------------------------------------ the claim --
/** May this PC start that run now? { ok: true, via } | { ok: false, by, why }. */
export async function claimRun(db, job) {
  if (!claimsOn()) return { ok: true, via: 'off' }
  try {
    const E = await env()
    const now = E.now()
    const key = keyOf(job), run_id = Number(job.id) || null
    const base = { key, run_id, profile_id: job.profile_id ?? null, workflow_id: job.workflow_id || null, pc_id: E.me.pc_id, pc_name: E.me.pc_name }
    if (run_id && (done.get(run_id) || 0) > now) return { ok: false, by: '', why: 'done already' }
    const held = alive(key, now)
    if (held && held.pc_id !== E.me.pc_id) return { ok: false, by: held.pc_name, why: `${held.pc_name} is doing it` }
    // Held here while the others are asked (two PCs asking at once see each other).
    const mineNow = { ...base, until: now + LEASE_MS, since: new Date(now).toISOString(), via: 'lan', mine: true, asking: true }
    leases.set(key, mineNow)
    const peers = E.node ? (await E.node.others().catch(() => [])).filter(p => p.pc_id && p.pc_id !== E.me.pc_id) : []
    const answers = await Promise.all(peers.map(p => askPeer(E.node, p, { op: 'try', ...base })))
    const no = answers.find(a => !a.away && a.granted === false)
    const yes = answers.filter(a => a.granted)
    const back = async () => { if (leases.get(key) === mineNow) leases.delete(key); await Promise.all(yes.map(a => askPeer(E.node, a.pc, { op: 'release', ...base }))) }
    if (no) { await back(); return { ok: false, by: no.holder?.pc_name || '', why: no.why || 'another PC is doing it' } }
    if (mineNow.lost) { await back(); const h = alive(key, E.now()); return { ok: false, by: h?.pc_name || '', why: `${h?.pc_name || 'another PC'} asked at the same moment and goes first` } }
    const away = answers.filter(a => a.away)
    let via = peers.length ? 'lan' : 'alone'
    if (away.length) {
      // Queued on a PC that is away but was there a moment ago: it may be running it, cut off.
      const owner = Number(job.id) >= 1e15 ? Number(job.id) % 1000 : null
      const ownerAway = away.find(a => owner != null && Number(a.pc.slot) === owner)
      const seen = ownerAway ? E.node?.peerState?.get(ownerAway.pc.pc_id)?.seen || 0 : 0
      if (ownerAway && now - seen < AWAY_MS) { await back(); return { ok: false, by: ownerAway.pc.name || '', why: `waiting for ${ownerAway.pc.name || 'the PC it was queued on'} (not on the network for under 5 minutes)` } }
      const online = await onlineStep(E, key, 'try', run_id)
      if (online.ok === false) { await back(); return { ok: false, by: online.holder?.pc_name || '', why: online.why || 'another PC is doing it (online copy)' } }
      if (online.down) {
        if (!queuedHere(job, E.slot(), E.isMain())) { await back(); return { ok: false, by: '', why: 'cut off from the other PCs: only runs queued on this PC' } }
        via = 'alone'
      } else via = 'online'
    }
    if (mineNow.lost || leases.get(key) !== mineNow) { await back(); const h = alive(key, E.now()); return { ok: false, by: h?.pc_name || '', why: 'another PC goes first' } }
    const lease = Object.assign(mineNow, { via, asking: false, until: E.now() + LEASE_MS, away: away.map(a => a.pc) })
    renewLater(E, lease)
    return { ok: true, via }
  } catch (e) {
    // Never a run lost to a claim error: this PC alone, as before.
    console.warn('[run claims]', e.message)
    return { ok: true, via: 'alone', error: e.message }
  }
}

function renewLater(E, lease) {
  if (!lease.run_id) return
  clearInterval(timers.get(lease.run_id))
  const t = setInterval(async () => {
    const l = leases.get(lease.key)
    if (!l || l.run_id !== lease.run_id || !l.mine) { clearInterval(t); timers.delete(lease.run_id); return }
    l.until = E.now() + LEASE_MS
    const peers = E.node ? (await E.node.others().catch(() => [])).filter(p => p.pc_id && p.pc_id !== E.me.pc_id) : []
    const answers = await Promise.all(peers.map(p => askPeer(E.node, p, { op: 'renew', key: l.key, run_id: l.run_id, profile_id: l.profile_id, workflow_id: l.workflow_id, pc_id: l.pc_id, pc_name: l.pc_name })))
    if (l.via === 'online' || answers.some(a => a.away)) await onlineStep(E, l.key, 'renew', l.run_id)
  }, RENEW_MS)
  t.unref?.()
  timers.set(lease.run_id, t)
}

/** The run ended (any way): the lease goes; a done run is remembered 15 minutes everywhere. */
export async function releaseRun(db, job, result = 'done') {
  if (!claimsOn()) return
  try {
    const E = await env()
    const key = keyOf(job), run_id = Number(job.id) || null
    clearInterval(timers.get(run_id)); timers.delete(run_id)
    const l = leases.get(key)
    if (l && l.mine && (!run_id || l.run_id === run_id)) leases.delete(key)
    if (result === 'done' && run_id) done.set(run_id, E.now() + DONE_MS)
    const body = { op: 'release', key, run_id, outcome: result, pc_id: E.me.pc_id, pc_name: E.me.pc_name }
    const peers = E.node ? (await E.node.others().catch(() => [])).filter(p => p.pc_id && p.pc_id !== E.me.pc_id) : []
    const answers = await Promise.all(peers.map(p => askPeer(E.node, p, body)))
    if (l?.via === 'online' || answers.some(a => a.away)) await onlineStep(E, key, result === 'done' ? 'done' : 'release', run_id)
  } catch (e) { console.warn('[run claims]', e.message) }
}

/** Who is doing what now, as this PC knows it (GET /api/run-claims). */
export function runClaimsNow(now = (deps?.now || Date.now)()) {
  return [...leases.values()].filter(l => l.until > now).map(({ until, mine, away, ...l }) => ({ ...l, here: !!mine, lease_s: Math.round((until - now) / 1000) }))
}
/** The PC doing a run for this girl now (a screen), or null. */
export const holderOf = (profileId) => runClaimsNow().find(l => String(l.profile_id) === String(profileId)) || null

/**
 * Another PC's lease ran out while its row still says running in this copy: that PC went
 * away mid-run. The row is failed, "stopped — PC went away" (nothing starts it again).
 */
export async function sweepGone(db, now = (deps?.now || Date.now)()) {
  let n = 0
  const E = await env()
  for (const [key, l] of leases) {
    if (l.mine || l.until > now) continue
    // Only a PC that is really gone: its lease out for 30 s more, not on the network now, silent online
    // (about 105 s after it died: 60 s lease + 30 s + the 15 s look).
    if (now - l.until < GRACE_MS) continue
    const st = E.node?.peerState?.get(l.pc_id)
    if (st?.ok && !blockedPeer(l.pc_id) && now - (st.seen || st.at || 0) < GRACE_MS) { leases.delete(key); continue }   // it is there: its run ended, the release was lost
    if (await onlineAlive(E, key, l.pc_id, now)) continue
    leases.delete(key)
    if (!l.run_id) continue
    try {
      const row = await db('automation_queue').where({ id: l.run_id }).first()
      if (row?.status !== 'running') continue
      let log = []; try { log = JSON.parse(row.log || '[]') } catch {}
      log.push({ ts: new Date(now).toISOString(), level: 'error', msg: `${GONE} (${l.pc_name})` })
      n += await db('automation_queue').where({ id: l.run_id, status: 'running' }).update({ status: 'failed', pause_reason: GONE, log: JSON.stringify(log), updated_at: new Date(now).toISOString() })
    } catch {}
  }
  return n
}
let swept = null
export function startRunClaims(db) {
  if (swept || !claimsOn() || (process.env.NODE_ENV === 'test' && process.env.ADAL_RUN_CLAIMS_SWEEP !== '1')) return
  swept = setInterval(() => sweepGone(db).catch(() => {}), SWEEP_MS)
  swept.unref?.()
}
