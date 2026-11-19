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

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SAFE = process.env.ADAL_BACKUP_SAFE || path.join(BACKEND, 'data', 'SafeStorage')
const DB_FILE = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.join(BACKEND, 'data.sqlite')

let node = null
export const syncNode = () => node
export const isMainRole = () => (node ? node.roles.isMain() : null)

/** This PC's version (the release it runs), for the list of PCs. */
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(BACKEND, '..', '.adal-version.json'), 'utf8')).sha?.slice(0, 12) || '' } catch { return '' }
}

export async function startSync(appDb, { timers = true } = {}) {
  if (process.env.ADAL_SYNC === '0') return null
  // An older follower PC opens the main PC's own pages: its database here is not the agency's.
  if ((await import('../mainPC.js')).isFollower()) return null
  const id = readIdentity()
  setSlot(id.slot)
  const db = knex({
    client: 'sqlite3', connection: { filename: DB_FILE }, useNullAsDefault: true,
    pool: { min: 1, max: 1, acquireTimeoutMillis: 120000, afterCreate(conn, done) { conn.run('PRAGMA journal_mode = WAL;'); conn.run('PRAGMA busy_timeout = 15000;'); conn.run('PRAGMA synchronous = NORMAL;', () => done(null, conn)) } },
  })
  const engine = new SyncEngine(db, { pcId: id.pc_id, slot: id.slot, log: console })
  await engine.init()
  const { getLanAddresses } = await import('../discovery.js')
  const mp = await import('../mainPC.js')
  node = new SyncNode({
    engine, safeDir: SAFE, key: id.key, port: Number(process.env.PORT) || 4000, name: os.hostname(), version: version(),
    addresses: () => getLanAddresses(), mainURL: () => mp.mainURL(), log: console,
  })
  node.relay = await makeRelay(appDb, id).catch(() => null)
  // An agency's existing Adal Keep takes the role at once; a Companion install waits until it joins.
  await node.start({ timers, claim: !mp.isCompanionInstall() && !id.joined_main })
  // The app's own windows reload what changed (changes.js), whatever PC changed it.
  const { changed, onChanged } = await import('../changes.js')
  engine.onChange((w) => { for (const t of w.applied || []) changed(t) })
  // A change made here goes into the log at once (then to the PCs on the network, node.pushSoon).
  let soon = null
  onChanged(() => { if (!soon) soon = setTimeout(() => { soon = null; engine.stampNow().catch(() => {}) }, 400) })
  // A table made after the start (a lazy one) is copied from the next check on.
  const t = setInterval(() => engine.refreshTables().catch(() => {}), 10 * 60 * 1000); t.unref?.()
  await reconcileRole()
  node.roles.onRole(() => reconcileRole({ restart: true }).catch(e => console.warn('[sync] role:', e.message)))
  if (node.roles.isMain()) startLicencePublisher()
  else followLicence()
  console.log(`🔁 Copying between the agency's PCs: this PC ${id.pc_id} (slot ${id.slot})${node.roles.isMain() ? ', the main PC' : `, main PC ${node.roles.holder() || '(none yet)'}`}`)
  return node
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
    const url = node.peerState.get(holder)?.url || (h?.lan?.[0] ? `http://${h.lan[0]}:${h.port || 4000}` : '') || mp.mainURL()
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
  })
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
      const found = await discoverServer({ timeoutMs: 2500 })
      const mp = await import('../mainPC.js')
      res.json({ found: found ? [found] : [], joined: !!readIdentity().joined_main, companion_install: mp.isCompanionInstall(), main_url: mp.mainURL() || null })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
  router.post('/sync/join-agency', async (req, res) => {
    if (!onThisPC(req)) return res.status(403).json({ error: 'Only on this PC itself' })
    try {
      const { joinAgency, stageJoin } = await import('./bootstrap.js')
      const { getLanAddresses } = await import('../discovery.js')
      const id = readIdentity()
      const got = await joinAgency({ mainUrl: req.body?.main_url, number: req.body?.number, name: os.hostname(), pcId: id.pc_id, lan: getLanAddresses(), port: Number(process.env.PORT) || 4000, dbFile: DB_FILE })
      await stageJoin(got, { dbFile: DB_FILE })
      updateIdentity({ slot: got.slot, key: got.key, joined_main: got.main_pc, joined_at: new Date().toISOString(), ...(got.online ? { online: got.online } : {}) })
      const mp = await import('../mainPC.js')
      mp.setRole({ mode: 'companion', main_url: got.main, pc_key: got.key })
      res.json({ ok: true, restart: true, slot: got.slot, main: got.main_name || got.main })
      setTimeout(() => process.exit(0), 1200)   // the copy goes in at the next start
    } catch (e) { res.status(e.status || 400).json({ error: e.message, ...(e.suspended ? { suspended: true } : {}) }) }
  })
  return router
}

export { currentSlot }
/** This PC joined an agency as a Companion with its own copy (or is waiting to: a Companion install). */
export const joinedAgency = () => !!readIdentity().joined_main
