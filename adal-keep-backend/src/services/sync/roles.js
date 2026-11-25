/**
 * roles.js — "main PC" is a role, not a different program.
 *
 * Every PC of the agency runs the same Adal Keep on its own copy. A few jobs
 * must run on ONE PC only: the robots (runs on the portals), the hourly
 * selection check and the daily Wafid check, the backups to Telegram, the
 * online copy for the phones, the licence. The PC holding the "main" role
 * does them (sync_role, copied to every PC like any table).
 *
 *   • A PC shows it is alive: sync_pcs.seen_at, every HEARTBEAT (copied).
 *   • The role is a lease on that: while the holder is seen (LEASE), nobody
 *     else takes it. When it is gone longer, a person on another PC may take
 *     the role there ("Make this PC the main PC"). The holder can also hand it
 *     to another PC.
 *   • Two PCs apart from each other could both take it: when they meet, the
 *     newer take wins (the newest stamp, as for every field) and the other
 *     stops its main-PC jobs at once (onRole).
 *   • By itself (autoStep, 2026-11-22: "when main is off, the adal companion
 *     should still work"): the lease run out, ONE of the PCs still alive takes
 *     the role — the one with the smallest slot — marked 'auto' with the PC
 *     it stood in for. That PC back (its heartbeat newer than the take, and
 *     reached on the office network now), the role is handed back to it.
 *     A role taken or handed by a person is never moved by itself.
 *   • Gone is what THIS PC saw itself (2026-11-25: Main lost its role twice while it was
 *     only restarting or off the Wi-Fi): the holder not reached and not a word of it for
 *     AUTO_AFTER while this PC was up and looking (not the age of a copied row: a PC just
 *     started, just woken, or with another clock took the role at once), and this PC's own
 *     network works (netProof). The PC it was taken from takes it back itself when it was
 *     not handed back in 10 minutes. Off: ADAL_ROLE_STEADY=0.
 *   • Equal PCs (ADAL_EQUAL_PCS, docs/equal-pcs.md): no PC is "the main
 *     PC" by install. Each PC writes how strong it is (sync_role
 *     'power:<pc_id>': cores, memory). The lease run out, the STRONGEST PC
 *     alive takes the role ('strongest'); a PC holding it by itself hands it
 *     to a PC on the network at least 1.5× stronger once no run is going
 *     ('stronger'). A role a person took or handed stays where it is.
 *   • The licence lives with the role: the holder writes its licence state
 *     (sync_role 'licence', signed with the licence key every build has), and
 *     the other PCs follow it — they open while it is paid or in its trial,
 *     and lock only with Adal's own signed lock in it (subscription.js).
 */
import crypto from 'crypto'
import os from 'os'

export const HEARTBEAT = Number(process.env.ADAL_SYNC_HEARTBEAT_MS) || 3 * 60 * 1000
export const LEASE = Number(process.env.ADAL_SYNC_LEASE_MS) || 15 * 60 * 1000
/** The role moves by itself only after this long without the holder, seen by this PC itself. */
export const AUTO_AFTER = Number(process.env.ADAL_AUTO_MAIN_AFTER_MS) || Number(process.env.ADAL_SYNC_LEASE_MS) || 30 * 60 * 1000
const GAP = 5 * 60 * 1000            // no look for this long (asleep, the clock moved): the wait starts again
const BACK_AFTER = 10 * 60 * 1000    // (a run is at most 10 minutes)
const steady = () => process.env.ADAL_ROLE_STEADY !== '0'

export class Roles {
  constructor(node) {
    this.node = node
    this.cache = null
    this.listeners = new Set()
    this.watch = new Map()    // pc_id → { seen, at, changed }: when THIS PC (its own clock) last saw a new heartbeat
    this.lastLook = 0
  }
  /** Look at every PC's heartbeat: a new one counts from now, by this PC's clock. */
  look(pcs) {
    const now = this.node.now()
    const gap = now - this.lastLook > GAP || now < this.lastLook
    this.lastLook = now
    for (const p of pcs) {
      const w = this.watch.get(p.pc_id)
      if (!w) this.watch.set(p.pc_id, { seen: p.seen_at, at: now, changed: 0 })
      else if (w.seen !== p.seen_at) Object.assign(w, { seen: p.seen_at, at: now, changed: now })
      else if (gap) w.at = now
    }
    if (gap) this.homeSince = 0
  }
  /** Gone for AUTO_AFTER as this PC saw it, and this PC is not the one that is cut off. */
  async holderGone(l, pcs) {
    if (!steady()) return !l.alive   // (the age of its row, by that PC's clock)
    const pc = pcs.find(p => p.pc_id === l.holder)
    if (!pc || pc.revoked_at || pc.suspended_at) return true
    const st = this.node.peerState?.get(l.holder)
    if (this.node.now() - Math.max(this.watch.get(l.holder)?.at || 0, st?.seen || 0) < AUTO_AFTER) return false
    const ok = await this.node.netProof?.(l.holder)
    if (ok === false && !this.saidCut) { this.saidCut = true; this.node.log?.warn?.('[sync] the main PC is not seen, but this PC reaches nobody else either: the main role is not taken') }
    if (ok) this.saidCut = false
    return ok !== false
  }
  /** On now, as this PC sees it: reached, or a new heartbeat within the lease. */
  onNow(p) {
    const now = this.node.now()
    if (p.pc_id === this.me) return true
    if (!steady()) return !!p.seen_at && now - Date.parse(p.seen_at) < LEASE
    const c = this.watch.get(p.pc_id)?.changed
    return !!this.node.peerState?.get(p.pc_id)?.ok || (!!c && now - c < LEASE)
  }
  get db() { return this.node.engine.db }
  get me() { return this.node.pcId }
  onRole(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  async read() {
    const rows = await this.db.raw(`SELECT k, holder, data, at FROM sync_role`)
    const out = {}
    for (const r of rows) { let data = null; try { data = JSON.parse(r.data || 'null') } catch {} out[r.k] = { holder: r.holder, data, at: r.at } }
    return out
  }

  /** Who holds the main role now (cached; refreshed after every change). */
  async refresh() {
    const before = this.cache?.main?.holder
    this.cache = await this.read()
    const after = this.cache.main?.holder
    if (before !== undefined && before !== after) for (const fn of this.listeners) { try { fn({ holder: after, mine: after === this.me }) } catch {} }
    return this.cache
  }
  holder() { return this.cache?.main?.holder || null }
  isMain() { return this.holder() === this.me }

  /** The first PC (an agency's existing Adal Keep): the role is its own. */
  async claimIfNone({ name } = {}) {
    await this.refresh()
    if (this.holder()) return false
    await this.write('main', this.me, { since: new Date(this.node.now()).toISOString(), by: name || this.me, how: 'first' })
    return true
  }

  async write(k, holder, data) {
    const at = new Date(this.node.now()).toISOString()
    await this.db.raw(`INSERT INTO sync_role (k, holder, data, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET holder = excluded.holder, data = excluded.data, at = excluded.at`, [k, holder, JSON.stringify(data), at])
    await this.node.engine.stampNow()
    await this.refresh()
  }

  async pcs() {
    return (await this.db.raw(`SELECT * FROM sync_pcs ORDER BY slot`)).map(p => ({ ...p, lan: safeJSON(p.lan, []), vector: safeJSON(p.vector, {}), macs: safeJSON(p.macs, []) }))
  }

  /** Is the holder's lease still running (seen within LEASE, as far as this PC knows)? */
  async leaseOf() {
    await this.refresh()
    const h = this.holder()
    if (!h) return { holder: null, alive: false }
    const pc = (await this.pcs()).find(p => p.pc_id === h)
    const seen = pc?.seen_at ? Date.parse(pc.seen_at) : 0
    const gone = !pc || pc.revoked_at || pc.suspended_at
    // Reached on the office network lately counts too: its heartbeat may not have come yet.
    const st = this.node.peerState?.get(h)
    const reached = st?.ok && this.node.now() - (st.seen || st.at || 0) < LEASE
    return { holder: h, name: pc?.name || h, seen_at: pc?.seen_at || null, alive: !gone && (this.node.now() - seen < LEASE || !!reached) }
  }

  /**
   * Take the main role on this PC. Refused while the holder's lease runs,
   * unless `force` (a person said the main PC is gone for good).
   */
  async take({ force = false, by = '' } = {}) {
    const l = await this.leaseOf()
    if (l.holder === this.me) return { ok: true, already: true }
    if (l.alive && !force) throw Object.assign(new Error(`${l.name} is the main PC and was seen ${ago(this.node.now(), l.seen_at)} — hand the role over there, or wait until it has been gone ${Math.round(LEASE / 60000)} minutes`), { status: 409 })
    const me = (await this.pcs()).find(p => p.pc_id === this.me)
    if (me?.suspended_at || me?.revoked_at) throw Object.assign(new Error('This PC was suspended or removed'), { status: 403 })
    await this.write('main', this.me, { since: new Date(this.node.now()).toISOString(), by: by || this.me, how: force ? 'taken (forced)' : 'taken', from: l.holder })
    return { ok: true, from: l.holder }
  }

  /**
   * The role moves by itself (see the top): taken when the holder's lease ran
   * out and this PC is the first of the PCs alive; handed back to the PC it
   * was taken from once that PC is back. → 'taken' | 'handed-back' | null.
   * canHandBack(): false while this PC must keep the role a little longer (a run going).
   */
  async autoStep({ canHandBack = () => true } = {}) {
    const l = await this.leaseOf()
    if (!l.holder) return null
    const now = this.node.now()
    const d = this.cache?.main?.data || {}
    const pcs = await this.pcs()
    this.look(pcs)
    if (l.holder === this.me) {
      if (d.how !== 'auto' || !d.from || d.from === this.me) return null
      const home = pcs.find(p => p.pc_id === d.from)
      if (!home || home.revoked_at || home.suspended_at) return null
      const seen = home.seen_at ? Date.parse(home.seen_at) : 0
      const st = this.node.peerState.get(d.from)
      // (Steady: reached now, and a word of it since the role was taken here — by this PC's clock.)
      if (steady() ? !(this.watch.get(d.from)?.changed > (this.tookAt || 0)) || now - (st?.seen || 0) > GAP : seen <= Date.parse(d.since || 0) || now - seen > LEASE) return null
      if (!st?.ok) return null
      if (!(await canHandBack())) return null
      await this.write('main', d.from, { since: new Date(now).toISOString(), by: 'auto', how: 'handed back', from: this.me })
      return 'handed-back'
    }
    const me = pcs.find(p => p.pc_id === this.me)
    if (!me || me.suspended_at || me.revoked_at) return null
    // This PC was stood in for and is up again: handed back within 10 minutes, or it takes its role back.
    if (steady() && d.how === 'auto' && d.from === this.me) {
      this.homeSince ||= now
      if (now - this.homeSince < BACK_AFTER) return null
      this.homeSince = 0
      await this.write('main', this.me, { since: new Date(now).toISOString(), by: 'auto', how: 'back', from: l.holder })
      return 'back'
    }
    this.homeSince = 0
    if (!(await this.holderGone(l, pcs))) return null
    const alive = pcs.filter(p => p.pc_id !== l.holder && !p.revoked_at && !p.suspended_at && this.onNow(p))
    alive.sort((a, b) => (a.slot || 0) - (b.slot || 0))
    if (alive[0]?.pc_id !== this.me) return null
    this.tookAt = now
    // Stood in for again (a chain): the role still goes back to the PC it first came from.
    const home = d.how === 'auto' && d.from ? d.from : l.holder
    await this.write('main', this.me, home === this.me
      ? { since: new Date(now).toISOString(), by: 'auto', how: 'back', from: l.holder }
      : { since: new Date(now).toISOString(), by: 'auto', how: 'auto', from: home, stood_in_for: l.holder })
    return 'taken'
  }

  // ── Equal PCs: the role with the strongest PC that is on ──────────────────

  /** How strong this PC is: 2 per core + 1 per GB of memory (a 2-core 4 GB PC: 8). */
  static power() {
    if (process.env.ADAL_PC_POWER) return { score: Number(process.env.ADAL_PC_POWER), cores: 0, ram_gb: 0 }
    const cores = os.cpus()?.length || 1, ram = Math.round(os.totalmem() / 2 ** 30)
    return { score: cores * 2 + ram, cores, ram_gb: ram }
  }
  powerOf(pcId) { return Number(this.cache?.[`power:${pcId}`]?.data?.score) || 0 }
  /** This PC's own power, written when it changed (copied to every PC). */
  async publishPower(p = Roles.power()) {
    await this.refresh()
    if (this.powerOf(this.me) === p.score) return false
    await this.write(`power:${this.me}`, this.me, p)
    return true
  }
  async autoStepEqual({ canHandBack = () => true } = {}) {
    const l = await this.leaseOf()
    const now = this.node.now()
    const d = this.cache?.main?.data || {}
    const pcs = await this.pcs()
    this.look(pcs)
    const reached = (id) => !!this.node.peerState?.get(id)?.ok
    const alive = (p) => !p.revoked_at && !p.suspended_at && (p.pc_id === this.me || reached(p.pc_id) || (p.seen_at && now - Date.parse(p.seen_at) < LEASE))
    const rank = (a, b) => this.powerOf(b.pc_id) - this.powerOf(a.pc_id) || (a.slot || 0) - (b.slot || 0)
    const me = pcs.find(p => p.pc_id === this.me)
    if (!me || me.suspended_at || me.revoked_at) return null
    if (l.holder === this.me) {
      if (!AUTO.has(d.how)) return null
      const best = pcs.filter(p => p.pc_id !== this.me && alive(p) && reached(p.pc_id)).sort(rank)[0]
      if (!best || this.powerOf(best.pc_id) < 1.5 * Math.max(1, this.powerOf(this.me))) return null
      if (!(await canHandBack())) return null
      await this.write('main', best.pc_id, { since: new Date(now).toISOString(), by: 'auto', how: 'stronger', from: this.me })
      return 'handed-stronger'
    }
    if (l.holder && !(await this.holderGone(l, pcs))) return null
    const first = pcs.filter(p => p.pc_id !== l.holder && alive(p)).sort(rank)[0]
    if (first?.pc_id !== this.me) return null
    await this.write('main', this.me, { since: new Date(now).toISOString(), by: 'auto', how: 'strongest', from: l.holder || null })
    return 'taken'
  }

  /** The holder gives the role to another PC of the agency. */
  async handTo(pcId, { by = '' } = {}) {
    await this.refresh()
    if (!this.isMain()) throw Object.assign(new Error('Only the main PC can hand its role over'), { status: 409 })
    const pc = (await this.pcs()).find(p => p.pc_id === pcId)
    if (!pc || pc.revoked_at || pc.suspended_at) throw Object.assign(new Error('No such PC in the agency'), { status: 404 })
    await this.write('main', pcId, { since: new Date(this.node.now()).toISOString(), by: by || this.me, how: 'handed over', from: this.me })
    return { ok: true }
  }

  // ── The licence, from the main PC to the others ───────────────────────────

  sign(data) {
    const key = this.node.licenceKey || ''
    return crypto.createHmac('sha256', key || 'no-key').update(`adal-keep-agency-licence:${canonical(data)}`).digest('hex')
  }
  /** The main PC: its licence state for every PC of the agency (only when it changed). */
  async publishLicence(st, adal = null) {
    await this.refresh()
    if (!this.isMain() || !st) return false
    const data = {
      mode: st.mode, trialEndsAt: st.trialEndsAt || null, paidUntil: st.paidUntil || null,
      // PCs on an older version lock when the trial or the paid time they read here is over: "for good" keeps
      // them open (never lock, 2026-11-25). Newer PCs read paidForGood, and Adal's signed file for a lock.
      forGood: !st.suspended, paidForGood: !!st.forGood, ...(adal ? { adal } : {}),
      suspended: !!st.suspended, suspendedAt: st.suspendedAt || null, suspendNote: st.suspendNote || '', pcNumber: st.pcNumber || null,
    }
    const old = this.cache?.licence?.data
    if (old && canonical({ ...old, sig: undefined }) === canonical(data) && this.cache.licence.holder === this.me) return false
    await this.write('licence', this.me, { ...data, sig: this.sign(data) })
    return true
  }
  /** The agency's licence as the main PC last wrote it (checked), or null. */
  licence() {
    const l = this.cache?.licence
    if (!l?.data?.sig) return null
    const { sig, ...data } = l.data
    if (sig !== this.sign(data)) return null
    return { ...data, from: l.holder, at: l.at }
  }
}

// Roles that moved by themselves (equal PCs may move them again); a person's take or hand-over stays.
const AUTO = new Set(['first', 'auto', 'back', 'handed back', 'strongest', 'stronger'])
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const ago = (now, at) => { const m = Math.round((now - Date.parse(at || 0)) / 60000); return at ? (m < 1 ? 'just now' : `${m} min ago`) : 'never' }
export function canonical(o) {
  if (o === undefined) return 'null'
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return `[${o.map(canonical).join(',')}]`
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
