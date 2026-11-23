/**
 * node.js — one PC of the agency, in the copying: its engine (the log), its
 * documents, its role, and the rounds with the other PCs.
 *
 *   • After any change here (a person, a robot): within a few seconds, to
 *     every other PC it can reach on the office network (push), and what they
 *     have back (pull).
 *   • Every PULL_EVERY anyway, with every PC it can reach.
 *   • A PC it cannot reach on the network: through the online copy (relay.js)
 *     — this PC's entries that PC has not had go up; the others' come down.
 *   • Documents: every round, what the other PC has and this one has not
 *     (docs.js), smallest first.
 *
 * Who the others are and where: sync_pcs (copied): each PC writes its own
 * office-network addresses and port there; the main PC's address is also in
 * data/main-pc.json. Calls carry this PC's key (x-adal-pc); the other PC
 * checks it against sync_pcs (its hash), and that the PC is not suspended
 * or removed.
 */
import os from 'os'
import { DocStore } from './docs.js'
import { DOC_COLUMNS } from './tables.js'
import { Roles, HEARTBEAT } from './roles.js'
import { keyHash } from './identity.js'
import { lanOrder, lanUsable } from '../discovery.js'

export const PULL_EVERY = 60 * 1000
const PUSH_DELAY = 2500
// Rows that ARE a document (an upload, a CV): when one comes, its file is fetched within seconds.
const DOC_TABLES = new Set(['files', 'generated_cvs', 'cv_templates', 'cv_headers'])
const LIMIT = 2000
const RELAY_EVERY = 3 * 60 * 1000

export class SyncNode {
  /**
   * engine: a SyncEngine (init()ed). safeDir: the documents folder.
   * key: this PC's key for the others. port: where this PC answers.
   * addresses(): this PC's office-network addresses. mainURL(): the main PC's
   * address as this PC knows it (main-pc.json), if any.
   */
  constructor({ engine, safeDir, uploadsDir = null, key, port = 4000, name = os.hostname(), version = '', addresses = () => [], macs = () => [], mainURL = () => '', relay = null, fetch: f = fetch, log = console, now = () => Date.now(), licenceKey = process.env.ADAL_LICENSE_KEY || '' }) {
    Object.assign(this, { engine, key, port, name, version, addresses, macs, mainURL, relay, f, log, now, licenceKey })
    this.finder = null           // peers.js: the agency's PCs found on the office network (UDP, ARP)
    this.docs = new DocStore(engine.db, safeDir, { log, now, uploadsDir })
    this.roles = new Roles(this)
    this.peerState = new Map()   // pc_id → { url, ok, at, error }
    this.timers = []
    this.busy = null
    this.status = { last: null, error: null, rounds: 0 }
  }
  get pcId() { return this.engine.pcId }
  /**
   * Suspended or removed by the main PC: from its own row (copied), or because
   * the other PCs refuse it (netCut). It still asks every round, so "allowed
   * again" is heard; it serves nothing to the others meanwhile.
   */
  get cutOff() { return this.rowCut || this.netCut || null }
  set cutOff(v) { this.netCut = v || null; if (!v) this.rowCut = null }

  async start({ timers = true, claim = true } = {}) {
    await this.selfRow()
    if (claim) await this.roles.claimIfNone({ name: this.name })
    await this.roles.refresh()
    await this.refreshKeys()
    await this.finder?.refresh().catch(() => {})
    this.engine.onChange((w) => {
      if (w.applied?.some(t => t === 'sync_role' || t === 'sync_pcs')) { this.roles.refresh().then(() => this.finder?.refresh()).catch(() => {}); this.refreshKeys().catch(() => {}) }
      if (w.stamped?.some(t => t === 'sync_role' || t === 'sync_pcs')) { this.refreshKeys().catch(() => {}); this.finder?.refresh().catch(() => {}) }
      // Changes made here, and those that came from another PC: on to every other PC
      // this one reaches (so a change goes round the office with no hub).
      if (w.stamped || w.applied?.length) this.pushSoon()
      // A document's row came (an upload, a CV on another PC): its file now, not at the next minute.
      if (w.applied?.some(t => DOC_TABLES.has(t))) this.roundSoon()
      if (w.stamped?.some(t => DOC_COLUMNS[t])) this.docs.touch()   // an upload here: counted at the next look
    })
    if (timers) {
      const every = (ms, fn) => { const t = setInterval(() => fn().catch(e => this.log.warn?.(`[sync] ${e.message}`)), ms); t.unref?.(); this.timers.push(t) }
      every(HEARTBEAT, () => this.selfRow())
      every(PULL_EVERY, () => this.round())
      every(20 * 1000, () => this.engine.stampNow())   // changes made by another program on this database
      every(60 * 60 * 1000, () => this.engine.compact())
      every(60 * 1000, () => this.docs.index())
      setTimeout(() => this.round().catch(() => {}), 3000).unref?.()
    }
    return this
  }
  roundSoon(ms = 3000) {
    if (this.soonTimer || !this.timers.length) return
    this.soonTimer = setTimeout(() => { this.soonTimer = null; this.round().catch(() => {}) }, ms)
    this.soonTimer.unref?.()
  }
  stop() { clearTimeout(this.soonTimer); for (const t of this.timers) clearInterval(t); this.timers = []; clearTimeout(this.pushTimer) }

  /** This PC's own row: where it is, that it is alive, what it has. */
  async selfRow() {
    const db = this.engine.db
    const lan = JSON.stringify(this.addresses())
    const macs = JSON.stringify((this.macs() || []).slice(0, 8))
    const at = new Date(this.now()).toISOString()
    const vec = JSON.stringify(await this.engine.vector())
    const row = (await db.raw(`SELECT * FROM sync_pcs WHERE pc_id = ?`, [this.pcId]))[0]
    if (!row) {
      await db.raw(`INSERT INTO sync_pcs (pc_id, name, slot, key_hash, joined_at, seen_at, lan, port, vector, version, macs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.pcId, this.name, this.engine.slot, keyHash(this.key), at, at, lan, this.port, vec, this.version, macs])
    } else {
      const set = { seen_at: at, vector: vec }
      if (row.lan !== lan) set.lan = lan
      if ((row.macs || '[]') !== macs) set.macs = macs
      if (Number(row.port) !== Number(this.port)) set.port = this.port
      if (row.name !== this.name) set.name = this.name
      if (row.version !== this.version) set.version = this.version
      if (Number(row.slot) !== Number(this.engine.slot)) set.slot = this.engine.slot
      if (!row.key_hash) set.key_hash = keyHash(this.key)
      const cols = Object.keys(set)
      await db.raw(`UPDATE sync_pcs SET ${cols.map(c => `"${c}" = ?`).join(', ')} WHERE pc_id = ?`, [...cols.map(c => set[c]), this.pcId])
    }
    await this.engine.stampNow()
  }

  /** The keys the agency's PCs may call this PC with (hash → PC), for the network gate. */
  async refreshKeys() {
    const rows = await this.engine.db.raw(`SELECT pc_id, name, key_hash, suspended_at, revoked_at FROM sync_pcs`)
    this.keys = new Map(rows.filter(r => r.key_hash).map(r => [r.key_hash, { pc_id: r.pc_id, name: r.name, suspended: !!r.suspended_at, revoked: !!r.revoked_at }]))
    this.pcRows = new Map(rows.map(r => [r.pc_id, { pc_id: r.pc_id, name: r.name, suspended: !!r.suspended_at, revoked: !!r.revoked_at }]))
    const me = rows.find(r => r.pc_id === this.pcId)
    this.rowCut = me?.revoked_at ? 'removed' : me?.suspended_at ? 'suspended' : null
    return this.keys
  }
  /** The agency PC a request's key belongs to (not suspended, not removed), or null. */
  peerByKey(key) {
    if (!key) return null
    const p = this.keys?.get(keyHash(key))
    return p && !p.suspended && !p.revoked && p.pc_id !== this.pcId ? p : null
  }
  peerKeyState(key) { const p = key ? this.keys?.get(keyHash(key)) : null; return p ? (p.revoked ? 'removed' : p.suspended ? 'suspended' : 'ok') : 'none' }

  // ── Talking to another PC ─────────────────────────────────────────────────

  async call(url, method, p, body, { timeout = 30000, raw = false, legacy = true } = {}) {
    // With the agency certificate (ADAL_EQUAL_PCS, trust.js): sealed. A PC that has no
    // certificate yet (an older version, still being moved over) gets the key as before,
    // unless strict — then only certificates.
    if (this.trust && this.trust.store.ready() && !(this.legacyAt?.get(url) > this.now() - 10 * 60000)) {
      try { return await this.trust.call(url, method, `/api/sync${p}`, body, { timeout, raw }) } catch (e) {
        // (Only the handshake itself: a PC that has no certificate route or none yet. Never to a
        // PC not on the agency's list — this PC's key is not shown to a stranger.)
        const older = (e.status === 404 || e.status === 503) && e.trust === true && !e.revoked
        if (!older || this.strict || !legacy || this.trust.wasCertified(url)) throw e
        this.legacyAt = this.legacyAt || new Map(); this.legacyAt.set(url, this.now())
      }
    }
    const r = await this.f(`${url}/api/sync${p}`, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { 'x-adal-pc': this.key, 'x-adal-sync-pc': this.pcId, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw Object.assign(new Error(j.error || `${url} answered ${r.status}`), { status: r.status, suspended: j.suspended })
    }
    return raw ? Buffer.from(await r.arrayBuffer()) : r.json()
  }

  /** The other PCs and the addresses to try for each (the one that worked last first). */
  async others() {
    const pcs = (await this.roles.pcs()).filter(p => p.pc_id !== this.pcId && !p.revoked_at && !p.suspended_at)
    const holder = this.roles.holder()
    return pcs.map(p => {
      const urls = new Set()
      const last = this.peerState.get(p.pc_id)?.url
      if (last) urls.add(last)
      // Where it answered the office network's broadcast lately (peers.js).
      for (const u of this.finder?.urlsOf(p.pc_id) || []) urls.add(u)
      if (p.pc_id === holder && this.mainURL()) urls.add(this.mainURL())
      for (const a of lanOrder(p.lan || [], this.addresses())) if (/^[\w.:[\]-]+$/.test(a)) urls.add(`http://${a.includes(':') && !a.startsWith('[') ? `[${a}]` : a}:${p.port || 4000}`)
      // (never a Tailscale / link-local address: another PC of the office times out there)
      return { ...p, urls: [...urls].filter(u => { try { return lanUsable(new URL(u).hostname) || /^(127\.|localhost)/.test(new URL(u).hostname) } catch { return false } }) }
    }).concat(this.trust ? this.newcomers(pcs) : [])
  }
  /**
   * Equal PCs: a PC heard on the office network with this agency's tag that is not on
   * the list yet (joined from the cloud a moment ago): tried too — its certificate decides.
   */
  newcomers(pcs) {
    const known = new Set([this.pcId, ...pcs.map(p => p.pc_id)])
    for (const [id, row] of this.pcRows || []) if (row.revoked || row.suspended) known.add(id)
    return [...(this.finder?.found || [])].filter(([id]) => !known.has(id)).map(([id, f]) => ({ pc_id: id, name: f.name, urls: this.finder.urlsOf(id), newcomer: true }))
  }

  /**
   * Find a PC on the network: the first address that answers as that PC —
   * the addresses it wrote in its row, where it answered the broadcast, and
   * last the addresses whose network card is its own (ARP, peers.js).
   */
  async reach(pc) {
    const tried = new Set()
    let again = false
    const tryAgain = async (url) => { again = true; tried.delete(url); return tryAll([url]) }
    const tryAll = async (urls) => {
      for (const url of urls) {
        if (tried.has(url)) continue
        tried.add(url)
        try {
          const h = await this.call(url, 'GET', '/hello', null, { timeout: 4000, legacy: !pc.newcomer })
          // Sealed: the PC is the one its certificate names, whatever its hello says.
          const certified = this.trust?.peerAt(url)
          if (certified && certified.pc_id !== pc.pc_id) continue
          // It came by the key but has its certificate now (moved over a moment ago): sealed from now on.
          if (h.cert && !again && this.legacyAt?.has(url) && this.trust?.store.ready()) { this.legacyAt.delete(url); return tryAgain(url) }
          if (h.pc_id === pc.pc_id) {
            this.peerState.set(pc.pc_id, { url, ok: true, at: this.now(), seen: this.now(), vector: h.vector || {}, main: !!h.main })
            return url
          }
        } catch (e) { if (e.suspended) { this.netCut = 'suspended'; throw e } }
      }
      return null
    }
    let url = await tryAll(pc.urls)
    if (!url && this.finder) url = await tryAll(this.finder.urlsOf(pc.pc_id)) || await tryAll(await this.finder.byCard(pc).catch(() => []))
    if (url) return url
    this.peerState.set(pc.pc_id, { ...(this.peerState.get(pc.pc_id) || {}), ok: false, at: this.now(), error: 'not on the network' })
    return null
  }

  /** Everything both ways with one PC (at that address), then its documents. */
  async syncWith(url, { docs = true } = {}) {
    const e = this.engine
    let theirs = null, pulled = 0, pushed = 0
    for (let i = 0; i < 1000; i++) {
      const r = await this.call(url, 'POST', '/pull', { vector: await e.vector(), limit: LIMIT }, { timeout: 120000 })
      if (r.entries?.length || Object.keys(r.complete || {}).length) await e.apply(r.entries || [], r.complete || {})
      pulled += r.entries?.length || 0
      theirs = r.vector || {}
      if (!r.more) break
    }
    for (let i = 0; i < 1000; i++) {
      const out = await e.changesSince(theirs, LIMIT)
      if (!out.entries.length) break
      const r = await this.call(url, 'POST', '/push', { entries: out.entries, complete: out.complete }, { timeout: 120000 })
      pushed += out.entries.length
      theirs = r.vector || theirs
      if (!out.more) break
    }
    for (const [id, st] of this.peerState) if (st.url === url) this.peerState.set(id, { ...st, seen: this.now(), vector: theirs || st.vector })
    let fetched = 0
    if (docs) fetched = await this.docsFrom(url)
    return { pulled, pushed, docs: fetched }
  }

  /** The documents that PC has and this one has not (a copy of the same content here first). */
  async docsFrom(url, { max = 200 } = {}) {
    await this.docs.index({ budgetMs: 2000 })
    const known = this.peerDocs?.get(url)
    const r = await this.call(url, 'GET', `/docs${known ? `?h=${known.hash}` : ''}`, null, { timeout: 60000 })
    const list = r.same && known ? known : r
    if (!r.same) { this.peerDocs = this.peerDocs || new Map(); this.peerDocs.set(url, r) }
    const want = await this.docs.missing(list.docs || [])
    let n = 0
    for (const d of want.slice(0, max)) {
      try {
        if (d.copyOf) await this.docs.copyLocal(d.copyOf, d.name, d.hash)
        else await this.docs.put(d.name, await this.call(url, 'GET', `/doc/${encodeURIComponent(d.name)}`, null, { timeout: 300000, raw: true }), d.hash)
        n++
      } catch (e) {
        if (e.status === 503) break   // that PC is busy: the rest at the next round
        this.log.warn?.(`[sync] ${d.name}: ${e.message}`)
      }
    }
    if (n) this.docs.listCache = null
    return n
  }

  /** One round: every PC that answers on the network; the online copy for the rest. */
  async round() {
    if (this.busy) return this.busy
    this.busy = (async () => {
      const res = { at: new Date(this.now()).toISOString(), peers: [], relay: null }
      let unreachable = 0
      // Some PC not reached last time (or never): ask the office network first (peers.js).
      const list0 = await this.others()
      if (this.finder && list0.some(p => !this.peerState.get(p.pc_id)?.ok)) await this.finder.search().catch(() => 0)
      for (const pc of await this.others()) {
        try {
          const url = await this.reach(pc)
          if (!url) { unreachable++; res.peers.push({ pc: pc.pc_id, name: pc.name, ok: false }); continue }
          const r = await this.syncWith(url)
          this.netCut = null   // (a PC of the agency took it: allowed again, if it had been cut off)
          res.peers.push({ pc: pc.pc_id, name: pc.name, ok: true, url, ...r })
        } catch (e) {
          if (e.suspended) this.netCut = 'suspended'
          unreachable++
          this.peerState.set(pc.pc_id, { ...(this.peerState.get(pc.pc_id) || {}), ok: false, at: this.now(), error: e.message })
          res.peers.push({ pc: pc.pc_id, name: pc.name, ok: false, error: e.message })
        }
      }
      // The online copy: only for PCs the office network did not reach.
      if (this.relay && (unreachable || await this.unacked()) && this.now() - (this.lastRelay || 0) > (unreachable ? 0 : RELAY_EVERY)) {
        try {
          this.lastRelay = this.now()
          const down = await this.relay.download()
          const up = (await this.unacked()) ? await this.relay.upload() : { sent: 0 }
          res.relay = { ...down, ...up }
        } catch (e) { res.relay = { error: e.message } }
      }
      this.status = { last: res, error: null, rounds: this.status.rounds + 1 }
      return this.status
    })()
    try { return await this.busy } catch (e) { this.status = { ...this.status, error: e.message }; throw e } finally { this.busy = null }
  }

  /** Some PC of the agency has not had all of this PC's changes (as far as its last word goes). */
  async unacked() {
    const mine = this.engine.seq
    if (!mine) return false
    for (const p of (await this.roles.pcs())) {
      if (p.pc_id === this.pcId || p.revoked_at || p.suspended_at) continue
      if ((p.vector?.[this.pcId] || 0) < mine && !this.peerState.get(p.pc_id)?.ok) return true
    }
    return false
  }

  /** Soon after a change here: to the PCs on the network (not the online copy: that waits for the round). */
  pushSoon() {
    if (this.pushTimer || !this.timers.length) return
    this.pushTimer = setTimeout(async () => {
      this.pushTimer = null
      for (const [pcId, st] of this.peerState) {
        if (!st.ok || !st.url) continue
        try {
          let theirs = (await this.call(st.url, 'GET', '/hello', null, { timeout: 4000 })).vector || {}
          for (let i = 0; i < 50; i++) {
            const out = await this.engine.changesSince(theirs, LIMIT)
            if (!out.entries.length) break
            theirs = (await this.call(st.url, 'POST', '/push', { entries: out.entries, complete: out.complete }, { timeout: 60000 })).vector || theirs
            if (!out.more) break
          }
          this.peerState.set(pcId, { ...this.peerState.get(pcId), seen: this.now(), vector: theirs })
        } catch (e) { this.peerState.set(pcId, { ...st, ok: false, error: e.message }) }
      }
    }, PUSH_DELAY)
    this.pushTimer.unref?.()
  }

  async hello() {
    return { pc_id: this.pcId, name: this.name, main: this.roles.isMain(), holder: this.roles.holder(), vector: await this.engine.vector(), version: this.version, ...(this.trust?.store.ready() ? { cert: true } : {}) }
  }

  /**
   * The main PC lets a new PC of the agency in (it came in with the main
   * PC's number, so its key is on the list): a slot of its own, its key in
   * sync_pcs for every PC.
   */
  async admit({ pc_id, name, key, access_id = null, lan = [], port = 4000 }) {
    await this.roles.refresh()
    if (!this.roles.isMain()) throw Object.assign(new Error('Only the main PC lets a PC join'), { status: 409 })
    if (!/^[0-9a-f]{12}$/.test(String(pc_id || ''))) throw Object.assign(new Error('Bad PC id'), { status: 400 })
    if (pc_id === this.pcId) throw Object.assign(new Error('That is this PC'), { status: 400 })
    const db = this.engine.db
    const had = (await db.raw(`SELECT * FROM sync_pcs WHERE pc_id = ?`, [pc_id]))[0]
    if (had?.suspended_at) throw Object.assign(new Error('This computer was suspended by the main PC'), { status: 403, suspended: true })
    let slot = had?.slot
    if (!Number.isInteger(Number(slot)) || slot == null) {
      const used = new Set((await db.raw(`SELECT slot FROM sync_pcs`)).map(r => Number(r.slot)))
      slot = 1
      while (used.has(slot)) slot++
      if (slot >= 1000) throw new Error('The agency has 999 PCs already')
    }
    const at = new Date(this.now()).toISOString()
    const row = { name: String(name || 'Companion').slice(0, 60), slot: Number(slot), key_hash: keyHash(key), access_id, joined_at: had?.joined_at || at, seen_at: at,
      lan: JSON.stringify(Array.isArray(lan) ? lan.slice(0, 8).map(String) : []), port: Number(port) || 4000, revoked_at: null }
    if (had) {
      const cols = Object.keys(row)
      await db.raw(`UPDATE sync_pcs SET ${cols.map(c => `"${c}" = ?`).join(', ')} WHERE pc_id = ?`, [...cols.map(c => row[c]), pc_id])
    } else {
      const cols = ['pc_id', ...Object.keys(row)]
      await db.raw(`INSERT INTO sync_pcs (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, [pc_id, ...Object.values(row)])
    }
    await this.engine.stampNow()
    await this.refreshKeys()
    return { slot: Number(slot), main_pc: this.pcId, main_name: this.name }
  }

  /** The main PC suspends a PC, allows it again, or removes it (every PC refuses it then). */
  async setCut(pcIdOrAccess, what) {
    const db = this.engine.db
    const at = new Date(this.now()).toISOString()
    const set = what === 'suspend' ? { suspended_at: at } : what === 'allow' ? { suspended_at: null } : { revoked_at: at }
    const cols = Object.keys(set)
    await db.raw(`UPDATE sync_pcs SET ${cols.map(c => `"${c}" = ?`).join(', ')} WHERE pc_id = ? OR access_id = ?`, [...cols.map(c => set[c]), pcIdOrAccess, pcIdOrAccess])
    await this.engine.stampNow()
    await this.refreshKeys()
  }
}
