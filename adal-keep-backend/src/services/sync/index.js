/**
 * sync/index.js — the copying, started on this PC (main.js): every PC of the
 * agency runs the same Adal Keep on its own full copy (docs/companion-full.md).
 *
 *   startSync(db)     after the migrations: the engine on its own plain knex,
 *                     this PC's identity, its role, the rounds
 *   syncNode()        the running node (routes, the network gate)
 *   isMainRole()      this PC holds the main PC's role (robots, backups …)
 *   syncRoutes()      /api/sync/* (routes/sync.js) plus this PC's own:
 *                     POST /sync/join-agency  {main_url, number} → a Companion with its own copy
 *
 * The role is also kept in data/main-pc.json (mode "companion" + the main
 * PC's address on a Companion), which the launcher and the synchronous
 * checks read. reconcileRole() puts it right at start, before anything
 * decides what runs here; a change while running restarts the server.
 */
import { presenceNow } from '../pcPresence.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import { fileURLToPath } from 'url'
import { SyncEngine } from './engine.js'
import { SyncNode } from './node.js'
import { Relay, SupabaseStore } from './relay.js'
import { readIdentity, updateIdentity } from './identity.js'
import { setSlot, currentSlot } from './ids.js'
import { createSyncRouter } from '../../routes/sync.js'
import { featureOn } from '../agencyConfig.js'
import { equalPCs } from './trust.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SAFE = process.env.ADAL_BACKUP_SAFE || path.join(BACKEND, 'data', 'SafeStorage')
const DB_FILE = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.join(BACKEND, 'data.sqlite')

let node = null
export const syncNode = () => node
/**
 * The copying between PCs is OFF unless switched on (2026-11-23, before the release: not yet
 * run on Windows): ADAL_COMPANION_FULL=1 on this PC, or Adal's switch "companion_full" for the
 * agency (agency config). Off, this PC works exactly as before (no sync tables, no time ids).
 */
export function companionFullOn() {
  const env = process.env.ADAL_COMPANION_FULL
  if (env === '1') return true
  if (env === '0') return false
  // Adal's signed tower command (tower.js companion_full_on/off) writes it here; it wins over the record.
  try { const f = JSON.parse(fs.readFileSync(process.env.ADAL_FLAGS_FILE || path.join(BACKEND, 'data', 'flags.json'), 'utf8'))?.companion_full; if (typeof f === 'boolean') return f } catch {}
  try { return featureOn('companion_full') } catch { return false }
}
/** The main role moving by itself: ADAL_AUTO_MAIN=1, or with the agency's switch above (ADAL_AUTO_MAIN=0 never). */
const autoMainOn = () => process.env.ADAL_AUTO_MAIN === '1' || (process.env.ADAL_AUTO_MAIN !== '0' && companionFullOn())
/** This PC logged out of its agency and has not joined one again (no main PC's jobs here then). */
export const leftAgency = () => { const id = readIdentity(); return !!id.left_at && !id.joined_main }
export const isMainRole = () => (node ? node.roles.isMain() : leftAgency() ? false : null)

/** This PC's version (the release it runs), for the list of PCs. */
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(BACKEND, '..', '.adal-version.json'), 'utf8')).sha?.slice(0, 12) || '' } catch { return '' }
}

export async function startSync(appDb, { timers = true } = {}) {
  if (process.env.ADAL_SYNC === '0') return null
  if (!companionFullOn() && !(await import('../mainPC.js')).isCompanionInstall()) return null
  // An older follower PC opens the main PC's own pages: its database here is not the agency's.
  if ((await import('../mainPC.js')).isFollower()) return null
  const id = readIdentity()
  // Logged out of its agency ("Log out of this main PC") and not joined again: no copying.
  if (id.left_at && !id.joined_main) { startLeaveRetry(); return null }
  // Started by adal-companion (its full copy, standby.go) and not joined yet: it joins by
  // itself with the key the main PC gave that program — nobody types anything.
  if (!id.joined_main && process.env.ADAL_SYNC_JOIN_MAIN && process.env.ADAL_SYNC_JOIN_KEY) { startAutoJoin(); return null }
  setSlot(id.slot)
  const db = knex({
    client: 'sqlite3', connection: { filename: DB_FILE }, useNullAsDefault: true,
    pool: { min: 1, max: 1, acquireTimeoutMillis: 120000, afterCreate(conn, done) { conn.run('PRAGMA journal_mode = WAL;'); conn.run('PRAGMA busy_timeout = 15000;'); conn.run('PRAGMA synchronous = NORMAL;', () => done(null, conn)) } },
  })
  const engine = new SyncEngine(db, { pcId: id.pc_id, slot: id.slot, log: console })
  await engine.init()
  const disco = await import('../discovery.js')
  const { getLanAddresses } = disco
  const mp = await import('../mainPC.js')
  node = new SyncNode({
    engine, safeDir: SAFE, uploadsDir: path.join(BACKEND, 'uploads'), key: id.key, port: Number(process.env.ADAL_ADVERTISE_PORT) || Number(process.env.PORT) || 4000, name: process.env.ADAL_PC_NAME || os.hostname(), version: version(),
    addresses: () => getLanAddresses(), macs: () => disco.macsOf(), mainURL: () => mp.mainURL(), log: console,
  })
  // The agency's PCs find each other on the office network, with or without the main PC (peers.js).
  const { PeerFinder } = await import('./peers.js')
  node.finder = new PeerFinder(node, { port: Number(process.env.DISCOVERY_PORT) || disco.DISCOVERY_PORT, macs: () => disco.macsOf(), log: console })
  // Every PC equal (ADAL_EQUAL_PCS, docs/equal-pcs.md): the agency certificate on both sides.
  const eq = equalPCs() ? await import('./equal.js') : null
  if (eq) eq.attachTrust(node)
  let soonRound = null
  disco.onPeerMessage((text, rinfo) => {
    const answer = node?.finder?.heard(text, rinfo)
    // A PC of the agency asking that this one has not reached lately (just switched on,
    // back on the network): a round with it now, not at the next minute.
    const m = /^ADAL_KEEP_PEERS_V1\|[^|]*\|([0-9a-f]{12})\|/.exec(text)
    if (answer && m && !node.peerState.get(m[1])?.ok && !soonRound) soonRound = setTimeout(() => { soonRound = null; node?.round().catch(() => {}) }, 1500)
    return answer
  })
  if (process.env.ADAL_ISOLATED !== '1' && !mp.isFollower()) disco.startDiscoveryResponder({ port: Number(process.env.DISCOVERY_PORT) || undefined, name: 'Adal Keep', answerServer: () => !mp.notMainPC() && isMainRole() !== false, getInfo: () => ({ port: Number(process.env.ADAL_ADVERTISE_PORT) || Number(process.env.PORT) || 4000 }) })
  node.relay = await makeRelay(appDb, id).catch(() => null)
  // An agency's existing Adal Keep takes the role at once; a Companion install waits until it joins.
  await node.start({ timers, claim: !mp.isCompanionInstall() && !id.joined_main })
  if (eq && timers) eq.startTrustJobs(node)
  // The app's own windows reload what changed (changes.js), whatever PC changed it.
  const { changed, onChanged } = await import('../changes.js')
  engine.onChange((w) => { for (const t of w.applied || []) changed(t) })
  // A change made here goes into the log at once (then to the PCs on the network, node.pushSoon).
  let soon = null
  onChanged(() => { if (!soon) soon = setTimeout(() => { soon = null; engine.stampNow().catch(() => {}) }, 400) })
  // A table made after the start (a lazy one) is copied from the next check on.
  const t = setInterval(() => engine.refreshTables().catch(() => {}), 10 * 60 * 1000); t.unref?.()
  // Holding the main role here: first a quick word with the other PCs (a few seconds at
  // most), so a role another PC took meanwhile (this PC was off) is heard BEFORE this
  // PC starts the robots — two PCs never run them at once.
  if (timers && node.roles.isMain() && (await node.others()).length) {
    await Promise.race([node.round().catch(() => {}), new Promise(r => setTimeout(r, Number(process.env.ADAL_START_ROUND_MS) || 6000).unref?.())])
    await node.roles.refresh()
  }
  await reconcileRole()
  node.roles.onRole(() => reconcileRole({ restart: true }).catch(e => console.warn('[sync] role:', e.message)))
  if (timers && autoMainOn()) startAutoRole()
  if (node.roles.isMain()) startLicencePublisher()
  else followLicence()
  console.log(`🔁 Copying between the agency's PCs: this PC ${id.pc_id} (slot ${id.slot})${node.roles.isMain() ? ', the main PC' : `, main PC ${node.roles.holder() || '(none yet)'}`}`)
  return node
}

// ── Joining by itself (a Companion program's full copy) ────────────────────

let joinTimer = null
/** One try now, then every 2 minutes until the main PC answers. A join that worked restarts the server. */
function startAutoJoin() {
  if (joinTimer) return
  const go = async () => {
    try {
      const r = await autoJoin()
      if (r) { clearInterval(joinTimer); joinTimer = null; setTimeout(() => process.exit(0), 1200) }
    } catch (e) { console.warn(`[sync] joining the agency: ${e.message} (again in 2 minutes)`) }
  }
  setTimeout(go, Number(process.env.ADAL_JOIN_FIRST_MS) || 3000).unref?.()
  joinTimer = setInterval(go, Number(process.env.ADAL_JOIN_RETRY_MS) || 2 * 60 * 1000)
  joinTimer.unref?.()
}
export async function autoJoin({ mainUrl = process.env.ADAL_SYNC_JOIN_MAIN, key = process.env.ADAL_SYNC_JOIN_KEY } = {}) {
  if (readIdentity().joined_main) return null
  const { joinAgency, stageJoin } = await import('./bootstrap.js')
  const { getLanAddresses } = await import('../discovery.js')
  const id = readIdentity()
  console.log(`[sync] joining the agency at ${mainUrl} with this Companion's key`)
  const got = await joinAgency({ mainUrl, key, name: process.env.ADAL_PC_NAME || os.hostname(), pcId: id.pc_id, lan: getLanAddresses(), port: Number(process.env.ADAL_ADVERTISE_PORT) || Number(process.env.PORT) || 4000, dbFile: DB_FILE })
  await stageJoin(got, { dbFile: DB_FILE })
  updateIdentity({ slot: got.slot, key: got.key, joined_main: got.main_pc, joined_at: new Date().toISOString(), left_at: null, leave_pending: null, ...(got.online ? { online: got.online } : {}) })
  const mp = await import('../mainPC.js')
  mp.setRole({ mode: 'companion', main_url: got.main, pc_key: got.key })
  console.log(`[sync] joined (slot ${got.slot}): the copy goes in at the restart`)
  return got
}

// ── The main role moves by itself (roles.autoStep) ─────────────────────────

let roleBusySince = 0
function startAutoRole() {
  const step = async () => {
    if (!node || node.cutOff) return
    const r = await node.roles[node.equal ? 'autoStepEqual' : 'autoStep']({
      // Handing back waits for the robots' runs going here, at most 10 minutes (the run limit).
      canHandBack: async () => {
        const { busyNow } = await import('../appLife.js')
        const b = await busyNow().catch(() => ({ busy: false }))
        if (!b.busy) { roleBusySince = 0; return true }
        roleBusySince = roleBusySince || Date.now()
        return Date.now() - roleBusySince > 10 * 60 * 1000
      },
    })
    if (!r) return
    console.log(r === 'taken' ? '[sync] the main PC is gone longer than its lease: this PC takes the main role by itself' : r === 'handed-stronger' ? '[sync] a stronger PC is on: the main role goes to it' : '[sync] the main PC is back: its role is handed back to it')
    await node.round().catch(() => {})   // the others hear it now
  }
  const t = setInterval(() => step().catch(e => console.warn('[sync] role step:', e.message)), Number(process.env.ADAL_AUTO_MAIN_MS) || 60 * 1000)
  t.unref?.()
}

/** The online copy for the relay: the agency's own account on the main PC; the Companion's on a Companion. */
async function makeRelay(appDb, id) {
  const { getSecret } = await import('../secretStore.js')
  const secret = () => getSecret('backup_password')
  if (!secret()) return null
  const cloud = await import('../cloudSync.js')
  let store = null
  if (id.online?.email && id.online?.password && id.online?.url) {
    let tok = null, until = 0
    const token = async () => {
      if (tok && Date.now() < until) return tok
      const r = await fetch(`${id.online.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: id.online.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: id.online.email, password: id.online.password }), signal: AbortSignal.timeout(20000) })
      const j = await r.json().catch(() => ({}))
      if (!j.access_token) throw new Error('The online account of this PC did not sign in')
      tok = j.access_token; until = Date.now() + (Number(j.expires_in || 3600) - 120) * 1000
      return tok
    }
    store = new SupabaseStore({ url: id.online.url, anon: id.online.anon, agency: id.online.agency, token })
  } else if (await cloud.cloudOn(appDb).catch(() => false)) {
    // The main PC: the agency's own online account (the one its online copy uses).
    const cc = await import('../chatCloud.js')
    const agency = await cc.cloudAgencyId(appDb).catch(() => null)
    if (agency) {
      const { url, anon } = cc.cloudConfig()
      store = new SupabaseStore({ url, anon, agency, token: () => cc.cloudToken(appDb) })
    }
  }
  if (!store) return null
  return new Relay(node, store, { get secret() { return secret() } })
}

/** data/main-pc.json follows the role (the launcher and the checks read it). Changed → a restart. */
export async function reconcileRole({ restart = false } = {}) {
  if (!node) return
  const mp = await import('../mainPC.js')
  await node.roles.refresh()
  const holder = node.roles.holder()
  if (!holder) return
  if (holder === node.pcId) {
    if (!mp.isCompanion()) return
    mp.setRole({ mode: '', main_url: '' })
    console.log('[sync] this PC holds the main PC\'s role now')
  } else {
    const pcs = await node.roles.pcs()
    const h = pcs.find(p => p.pc_id === holder)
    const url = presenceNow()?.urlsOf(holder)[0] || node.peerState.get(holder)?.url || (h?.lan?.[0] ? `http://${h.lan[0]}:${h.port || 4000}` : '') || mp.mainURL()
    if (mp.isCompanion() && (mp.mainURL() === url || !url)) return
    mp.setRole({ mode: 'companion', main_url: url, pc_key: readIdentity().key })
    console.log(`[sync] ${h?.name || holder} holds the main PC's role: this PC is a Companion with its own copy`)
  }
  if (restart) setTimeout(() => process.exit(0), 1500)   // the launcher (AdalKeep.exe) or the service starts it again
}

// ── The licence: written by the main PC, followed by the others ────────────

function startLicencePublisher() {
  const go = async () => {
    const { statusPayload } = await import('../subscription.js')
    await node.roles.publishLicence(statusPayload())
  }
  go().catch(() => {})
  const t = setInterval(() => go().catch(() => {}), 30 * 60 * 1000); t.unref?.()
}
async function followLicence() {
  const sub = await import('../subscription.js')
  sub.followAgencyLicence(() => ({ licence: node.roles.licence(), cutOff: node.cutOff }))
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function syncRoutes() {
  const { onThisPC } = await import('../../routes/trash.js')
  const { keyOf, approvedPC } = await import('../networkGate.js')
  const router = createSyncRouter({
    getNode: () => node,
    here: onThisPC,
    keyOf,
    admitted: (req) => req.pcAccess || approvedPC(req),
    onJoined: async () => { const { ensureBackupKey } = await import('../telegramBackup.js'); ensureBackupKey() },
    onRole: () => reconcileRole({ restart: true }).catch(() => {}),
    // Equal PCs: a PC with its certificate takes its first copy from this one (bootstrap.js).
    joinData: equalPCs() ? await joinData() : null,
  })
  if (equalPCs()) (await import('./equal.js')).equalRoutes(router, { getNode: () => node, here: onThisPC, keyOf, dbFile: DB_FILE })
  /**
   * This PC joins an agency as a Companion with its own full copy: the main
   * PC's number, then its database (and later its documents). The database
   * this PC had is kept beside (data.sqlite.before-join-…). Restarts.
   */
  /** The main PCs that answer on the office network (for the join screen). */
  router.get('/sync/find-main', async (req, res) => {
    if (!onThisPC(req)) return res.status(403).json({ error: 'Only on this PC itself' })
    try {
      const { discoverServer } = await import('../discovery.js')
      const found = await discoverServer({ timeoutMs: 2500, port: Number(process.env.DISCOVERY_PORT) || undefined })
      const mp = await import('../mainPC.js')
      res.json({ found: found ? [found] : [], joined: !!readIdentity().joined_main, companion_install: mp.isCompanionInstall(), main_url: mp.mainURL() || null })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
  /** "Log out of this main PC" (a Companion with its own copy): leaves the agency, stops the copying. */
  router.post('/sync/leave-agency', async (req, res) => {
    if (!onThisPC(req)) return res.status(403).json({ error: 'Only on this PC itself' })
    try { res.json({ ok: true, ...(await leaveAgency({ device: req.body?.device })) }) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })
  router.post('/sync/join-agency', async (req, res) => {
    if (!onThisPC(req)) return res.status(403).json({ error: 'Only on this PC itself' })
    try {
      const { joinAgency, stageJoin } = await import('./bootstrap.js')
      const { getLanAddresses } = await import('../discovery.js')
      const id = readIdentity()
      const got = await joinAgency({ mainUrl: req.body?.main_url, number: req.body?.number, name: os.hostname(), pcId: id.pc_id, lan: getLanAddresses(), port: Number(process.env.PORT) || 4000, dbFile: DB_FILE })
      await stageJoin(got, { dbFile: DB_FILE })
      updateIdentity({ slot: got.slot, key: got.key, joined_main: got.main_pc, joined_at: new Date().toISOString(), left_at: null, leave_pending: null, ...(got.online ? { online: got.online } : {}) })
      const mp = await import('../mainPC.js')
      mp.setRole({ mode: 'companion', main_url: got.main, pc_key: got.key })
      res.json({ ok: true, restart: true, slot: got.slot, main: got.main_name || got.main })
      setTimeout(() => process.exit(0), 1200)   // the copy goes in at the next start
    } catch (e) { res.status(e.status || 400).json({ error: e.message, ...(e.suspended ? { suspended: true } : {}) }) }
  })
  return router
}

async function joinData() {
  const { snapshotSource } = await import('./bootstrap.js')
  const { replicaKeys } = await import('../replica.js')
  let src = null
  const source = () => (src = src || snapshotSource({ db: node.engine.db, dir: path.join(BACKEND, 'data', 'tmp') }))
  return { keys: () => replicaKeys(), manifest: () => source().manifest(), piece: (s, i) => source().piece(s, i) }
}

// ── "Log out of this main PC" on a Companion with its own copy ─────────────

/**
 * This PC leaves its agency: its own row says removed (every PC refuses it from
 * then on), the PCs it reaches hear it now, the main PC lets go of its key and
 * its online account (/pc-access/leave), and the copying stops here. The copy
 * of the data stays on this PC (it is replaced, and kept beside, when it joins
 * an agency again). The main PC not reachable now: asked again every 2 minutes
 * (30 days).
 */
export async function leaveAgency({ device = '' } = {}) {
  const n = node
  const id = readIdentity()
  const mp = await import('../mainPC.js')
  if (!n && !id.joined_main) throw Object.assign(new Error('This PC is not in an agency'), { status: 409 })
  if (n?.roles.isMain()) throw Object.assign(new Error('This PC is the main PC: hand the role to another PC first'), { status: 409 })
  const out = { told_peers: 0, main: false }
  const mains = []
  if (n) {
    const holder = n.roles.holder()
    const h = n.peerState.get(holder)
    if (h?.url) mains.push(h.url)
    await n.setCut(n.pcId, 'remove').catch(() => {})
    // The others hear it now (one push each): they refuse this PC from now on.
    for (const [, st] of n.peerState) {
      if (!st.ok || !st.url) continue
      try {
        const theirs = (await n.call(st.url, 'GET', '/hello', null, { timeout: 4000 })).vector || {}
        const o = await n.engine.changesSince(theirs, 2000)
        if (o.entries.length) await n.call(st.url, 'POST', '/push', { entries: o.entries, complete: o.complete }, { timeout: 30000 })
        out.told_peers++
      } catch {}
    }
    n.stop()
    node = null
  }
  if (mp.mainURL() && !mains.includes(mp.mainURL())) mains.push(mp.mainURL())
  const pending = { mains, key: id.key, device: String(device || id.online?.device || ''), at: Date.now() }
  out.main = await tellMainWeLeft(pending)
  updateIdentity({ joined_main: null, left_at: new Date().toISOString(), left_from: id.joined_main || null, leave_pending: out.main ? null : pending })
  mp.setRole({ mode: '', main_url: '' })
  if (!out.main) startLeaveRetry()
  console.log(`[sync] this PC logged out of its agency${out.main ? '' : ' (the main PC is told when it answers)'}; ${out.told_peers} PC(s) heard it`)
  return out
}

async function tellMainWeLeft(p) {
  for (const u of p?.mains || []) {
    try {
      const r = await fetch(`${u}/api/pc-access/leave`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adal-pc': p.key }, body: JSON.stringify(p.device ? { device: p.device } : {}), signal: AbortSignal.timeout(8000) })
      // (401/403: that PC does not know this key any more — nothing left to stop there.)
      if (r.ok || r.status === 401 || r.status === 403) return true
    } catch {}
  }
  return false
}

let leaveTimer = null
function startLeaveRetry() {
  if (leaveTimer) return
  leaveTimer = setInterval(async () => {
    const id = readIdentity()
    const p = id.leave_pending
    if (!p || id.joined_main || Date.now() - (p.at || 0) > 30 * 24 * 3600 * 1000) { clearInterval(leaveTimer); leaveTimer = null; if (p && !id.joined_main) updateIdentity({ leave_pending: null }); return }
    if (await tellMainWeLeft(p)) { updateIdentity({ leave_pending: null }); clearInterval(leaveTimer); leaveTimer = null; console.log('[sync] the main PC let go of this PC (logged out earlier)') }
  }, Number(process.env.ADAL_LEAVE_RETRY_MS) || 2 * 60 * 1000)
  leaveTimer.unref?.()
}

export { currentSlot }
/** This PC joined an agency as a Companion with its own copy (or is waiting to: a Companion install). */
export const joinedAgency = () => !!readIdentity().joined_main
