/**
 * authority.js — Adal's cloud side of the agency's identity (trust.js,
 * docs/equal-pcs.md). The same code runs in the Supabase function
 * (adal-admin/supabase/agency-trust.sql has its tables) and, in tests, as a
 * cloud of its own (an in-memory store).
 *
 *   createAgency(agency_id, code)  the agency's key; the anchor signed with Adal's root key
 *   requestJoin({code, pc_id, device_pub, name, slot?})
 *                                  a PC asks to join (agency code); → {request_id}
 *   approveByPC({request_id, cert, sig})
 *                                  a PC of the agency says Yes, signing with its device key
 *   approveByAdmin(request_id)     Adal says Yes (Admin)
 *   collect({request_id, sig})     the asking PC picks up its certificate (signed with its device key)
 *   revoke(agency_id, pc_id)       Admin cuts a PC off: the revoked list goes one up
 *   crl(agency_id)                 the newest revoked list
 *   reserveSlots(agency_id, rows)  migration: the slots the agency's PCs already have stay theirs
 *
 * A Yes is for one request (one PC id, one device key). Slots (the last three
 * digits of every id a PC makes) are handed out here, so two PCs never share
 * one, with or without a main PC.
 */
import crypto from 'node:crypto'
import { newSigningKey, sign, verify, checkCert, checkCRL } from './trust.js'

const CERT_DAYS = 400
const err = (msg, status = 400) => Object.assign(new Error(msg), { status })

/** The store: get(kind, id) / put(kind, id, row) / list(kind, filter). In memory for tests. */
export class MemoryStore {
  constructor() { this.m = new Map() }
  async get(kind, id) { return structuredClone(this.m.get(`${kind}:${id}`) ?? null) }
  async put(kind, id, row) { this.m.set(`${kind}:${id}`, structuredClone(row)); return row }
  async list(kind, fn = () => true) { return [...this.m].filter(([k]) => k.startsWith(kind + ':')).map(([, v]) => structuredClone(v)).filter(fn) }
}

export class Authority {
  /** rootPriv: Adal's root key (JWK). */
  constructor({ store = new MemoryStore(), rootPriv, now = () => Date.now() }) {
    Object.assign(this, { store, rootPriv, now })
  }
  iso() { return new Date(this.now()).toISOString() }

  async createAgency(agencyId, code) {
    if (await this.store.get('agency', agencyId)) throw err('That agency has its key already', 409)
    const k = newSigningKey()
    const p = { v: 1, agency_id: agencyId, agency_pub: k.pub, issued_at: this.iso() }
    const anchor = { p, s: sign(this.rootPriv, 'adal-agency-anchor-v1', p) }
    const crlP = { v: 1, agency_id: agencyId, version: 1, at: this.iso(), revoked: [] }
    const row = { agency_id: agencyId, code: String(code || '').replace(/\D/g, ''), priv: k.priv, anchor, crl: { p: crlP, s: sign(k.priv, 'adal-agency-crl-v1', crlP) }, slots: {}, serial: 0 }
    await this.store.put('agency', agencyId, row)
    return { anchor }
  }
  async agencyByCode(code) {
    const c = String(code || '').replace(/\D/g, '')
    return c ? (await this.store.list('agency', a => a.code === c))[0] || null : null
  }

  async requestJoin({ code, pc_id, device_pub, name = '', slot = null }) {
    const a = await this.agencyByCode(code)
    if (!a) throw err('No agency with that code', 404)
    if (!/^[0-9a-f]{12}$/.test(String(pc_id || '')) || !/^[A-Za-z0-9_-]{43}$/.test(String(device_pub || ''))) throw err('Bad request')
    const id = crypto.randomBytes(16).toString('base64url')
    await this.store.put('request', id, { id, agency_id: a.agency_id, pc_id, device_pub, name: String(name).slice(0, 60), slot: Number.isInteger(slot) ? slot : null, at: this.iso(), approved: null })
    return { request_id: id }
  }
  async pending(agencyId) {
    return (await this.store.list('request', r => r.agency_id === agencyId && !r.approved && !r.denied && this.now() - Date.parse(r.at) < 7 * 864e5)).map(({ cert, ...r }) => r)
  }

  /** A PC of the agency says Yes: its certificate (valid, not revoked) and its signature over the request. */
  async approveByPC({ request_id, anchor, cert, sig }) {
    const r = await this.store.get('request', request_id)
    if (!r || r.approved) throw err('No such request', 404)
    const a = await this.store.get('agency', r.agency_id)
    const by = checkCert(anchor || a.anchor, cert, { agencyId: r.agency_id, now: this.now(), crl: a.crl })
    if (!verify(by.device_pub, 'adal-join-approve-v1', { request_id, pc_id: r.pc_id, device_pub: r.device_pub }, sig)) throw err('That Yes is not signed by that PC', 403)
    return this.approve(r, a, `pc:${by.pc_id}`)
  }
  async approveByAdmin(requestId) {
    const r = await this.store.get('request', requestId)
    if (!r || r.approved) throw err('No such request', 404)
    return this.approve(r, await this.store.get('agency', r.agency_id), 'admin')
  }
  async approve(r, a, by) {
    // The slot: the one it already had in the agency (migration), else the next free one.
    const used = new Map(Object.entries(a.slots || {}).map(([pc, s]) => [Number(s), pc]))
    let slot = a.slots?.[r.pc_id]
    if (slot == null && r.slot != null && !used.has(r.slot)) slot = r.slot
    if (slot == null) { slot = 1; while (used.has(slot)) slot++ }
    if (slot >= 1000) throw err('The agency has 999 PCs already', 409)
    a.slots = { ...(a.slots || {}), [r.pc_id]: slot }
    a.serial = (a.serial || 0) + 1
    const p = { v: 1, agency_id: a.agency_id, pc_id: r.pc_id, slot: Number(slot), name: r.name, device_pub: r.device_pub, serial: `${a.agency_id.slice(0, 8)}-${a.serial}-${crypto.randomBytes(4).toString('hex')}`, issued_at: this.iso(), expires_at: new Date(this.now() + CERT_DAYS * 864e5).toISOString() }
    const cert = { p, s: sign(a.priv, 'adal-device-cert-v1', p) }
    await this.store.put('agency', a.agency_id, a)
    await this.store.put('request', r.id, { ...r, approved: { by, at: this.iso() }, cert })
    await this.store.put('device', p.serial, { ...p, approved_by: by })
    return { ok: true, pc_id: r.pc_id, slot: p.slot }
  }

  /** The asking PC picks up its certificate (only it: signed with the device key of the request). */
  async collect({ request_id, sig }) {
    const r = await this.store.get('request', request_id)
    if (!r) throw err('No such request', 404)
    if (!verify(r.device_pub, 'adal-join-collect-v1', { request_id }, sig)) throw err('Not the PC that asked', 403)
    if (!r.cert) return { waiting: true }
    const a = await this.store.get('agency', r.agency_id)
    return { anchor: a.anchor, cert: r.cert, crl: a.crl }
  }

  /** Admin cuts a PC off: every certificate it had until now is on the list (a later join is a new certificate). */
  async revoke(agencyId, pcId) {
    const a = await this.store.get('agency', agencyId)
    if (!a) throw err('No such agency', 404)
    const p = { ...a.crl.p, version: a.crl.p.version + 1, at: this.iso(), revoked: [...a.crl.p.revoked.filter(x => x.pc_id !== pcId), { pc_id: pcId, before: this.iso(), at: this.iso() }] }
    a.crl = { p, s: sign(a.priv, 'adal-agency-crl-v1', p) }
    await this.store.put('agency', agencyId, a)
    return a.crl
  }
  async crl(agencyId) { const a = await this.store.get('agency', agencyId); if (!a) throw err('No such agency', 404); return checkCRL(a.anchor, a.crl) }

  /** Migration: an approved PC of the agency writes the slots its PCs already use (sync_pcs), so none is given twice. */
  async reserveSlots(agencyId, rows, { cert, sig } = {}) {
    const a = await this.store.get('agency', agencyId)
    if (!a) throw err('No such agency', 404)
    const by = checkCert(a.anchor, cert, { agencyId, now: this.now(), crl: a.crl })
    if (!verify(by.device_pub, 'adal-reserve-slots-v1', { rows }, sig)) throw err('Not signed by that PC', 403)
    const used = new Map(Object.entries(a.slots || {}).map(([pc, s]) => [Number(s), pc]))
    for (const { pc_id, slot } of rows || []) {
      if (!/^[0-9a-f]{12}$/.test(pc_id) || !Number.isInteger(slot) || slot < 1 || slot > 999) continue
      if (used.has(slot) && used.get(slot) !== pc_id) continue
      if (a.slots[pc_id] != null) continue
      a.slots[pc_id] = slot; used.set(slot, pc_id)
    }
    await this.store.put('agency', agencyId, a)
    return { slots: a.slots }
  }
}

/** The PC side of joining (the cloud over HTTP, or an Authority itself in tests). */
export const approveSig = (devicePriv, r) => sign(devicePriv, 'adal-join-approve-v1', { request_id: r.request_id, pc_id: r.pc_id, device_pub: r.device_pub })
export const collectSig = (devicePriv, requestId) => sign(devicePriv, 'adal-join-collect-v1', { request_id: requestId })
export const reserveSig = (devicePriv, rows) => sign(devicePriv, 'adal-reserve-slots-v1', { rows })

/**
 * The cloud's one door (the Supabase function agency-trust, and the tests' cloud):
 * {op, ...} → the answer. Admin's own ops (create, admin-approve, revoke) need the
 * admin flag, which only the function sets after checking Adal's service key.
 */
export async function handle(authority, { op, ...b } = {}, { admin = false } = {}) {
  switch (op) {
    case 'request': return authority.requestJoin(b)
    case 'pending': {
      // Only a PC of that agency sees who asks (its certificate, signed now).
      const a = await authority.store.get('agency', b.agency_id)
      if (!a) throw err('No such agency', 404)
      const by = checkCert(a.anchor, b.cert, { agencyId: b.agency_id, now: authority.now(), crl: a.crl })
      if (!verify(by.device_pub, 'adal-join-pending-v1', { agency_id: b.agency_id, at: b.at }, b.sig) || Math.abs(authority.now() - Date.parse(b.at)) > 5 * 60000) throw err('Not signed by that PC', 403)
      return { pending: await authority.pending(b.agency_id) }
    }
    case 'approve': return authority.approveByPC(b)
    case 'collect': return authority.collect(b)
    case 'crl': return { crl: await authority.crl(b.agency_id) }
    case 'reserve': return authority.reserveSlots(b.agency_id, b.rows, b)
    case 'create': if (!admin) throw err('Admin only', 403); return authority.createAgency(b.agency_id, b.code)
    case 'admin-approve': if (!admin) throw err('Admin only', 403); return authority.approveByAdmin(b.request_id)
    case 'revoke': if (!admin) throw err('Admin only', 403); return { crl: await authority.revoke(b.agency_id, b.pc_id) }
    default: throw err('No such op', 404)
  }
}
export const pendingSig = (devicePriv, agencyId, at) => sign(devicePriv, 'adal-join-pending-v1', { agency_id: agencyId, at })

/** A PC talking to the cloud's door over HTTP (url: the function's address). */
export class CloudTrust {
  constructor({ url, headers = {}, fetch: f = fetch }) { Object.assign(this, { url, headers, f }) }
  async op(op, body = {}) {
    const r = await this.f(this.url, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers }, body: JSON.stringify({ op, ...body }), signal: AbortSignal.timeout(20000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(j.error || `The cloud answered ${r.status}`), { status: r.status })
    return j
  }
}

/**
 * The cloud's store: one table, agency_trust (adal-admin/supabase/agency-trust.sql),
 * read and written only with Adal's service key (Admin, the agency-trust function).
 */
export class SupabaseTrustStore {
  constructor({ url, key, fetch: f = fetch }) { Object.assign(this, { url: String(url).replace(/\/+$/, ''), key, f }) }
  async req(method, q, body) {
    const r = await this.f(`${this.url}/rest/v1/agency_trust${q}`, {
      method, headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) throw err(`The cloud's store answered ${r.status}`, 502)
    return method === 'GET' ? r.json() : null
  }
  async get(kind, id) { const rows = await this.req('GET', `?kind=eq.${encodeURIComponent(kind)}&id=eq.${encodeURIComponent(id)}&select=data`); return rows[0]?.data ?? null }
  async put(kind, id, row) { await this.req('POST', '', { kind, id, agency_id: row.agency_id || null, data: row }); return row }
  async list(kind, fn = () => true) { return (await this.req('GET', `?kind=eq.${encodeURIComponent(kind)}&select=data`)).map(r => r.data).filter(fn) }
}
