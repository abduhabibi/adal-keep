/**
 * trust.js — how the agency's PCs know each other (behind ADAL_EQUAL_PCS,
 * docs/equal-pcs.md). "How would PCs recognize each other and say I am from
 * this agency?"
 *
 *   Adal's root key   one Ed25519 key, its private half only with Adal
 *                     (~/.adal-keep/agency-root.jwk); its public half is in
 *                     every build (ROOT_PUBS).
 *   the agency key    one Ed25519 key per agency, held by Adal's cloud
 *                     (authority.js). The root signs "this key is agency X"
 *                     (the anchor), so nobody can make a key of their own and
 *                     call it Adal Nuzla.
 *   a device key      made on each PC, never leaves it (data/agency-trust.json).
 *   a certificate     the cloud signs "PC <pc_id>, slot <n>, device key <k> is
 *                     of agency X" with the agency key — once the PC joined
 *                     (agency code + a Yes from a PC of the agency, or from Admin).
 *   the revoked list  signed by the agency key, numbered; the newest one wins,
 *                     and every PC hands it to every PC it meets (offline too).
 *
 * Two PCs meet (handshake, two calls): each shows its anchor + certificate and
 * a fresh one-time key (X25519), each signs the whole conversation with its
 * device key. A PC of another agency (its anchor says another agency), a made-up
 * one (no root signature), a copied certificate (no device key to sign with) or
 * a revoked one is refused. Both work out the same session key; every call
 * after is sealed with it (AES-256-GCM, numbered, never twice) — somebody on the
 * same Wi-Fi reads nothing and cannot replay a call.
 *
 * Everything is checked here on the PC: after the first join it all works with
 * no internet (the anchor, the certificate and the list are kept on disk).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data')
export const trustFile = () => process.env.ADAL_TRUST_FILE || path.join(DATA, 'agency-trust.json')

/** Adal's root public keys (base64url Ed25519). The private half: ~/.adal-keep/agency-root.jwk — never regenerate. */
export const ROOT_PUBS = ['vwtrRLE1SGBpykoErm89wQ2o5TQkV5n8O3_Q38JvEfY']
const roots = () => [...ROOT_PUBS, ...String(process.env.ADAL_TRUST_ROOT_PUB || '').split(',').filter(Boolean)]

export const equalPCs = () => ['1', 'strict'].includes(String(process.env.ADAL_EQUAL_PCS || ''))
export const strictTrust = () => process.env.ADAL_EQUAL_PCS === 'strict'

// ── Signing ─────────────────────────────────────────────────────────────────

export function canonical(o) {
  if (o === undefined) return 'null'
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return `[${o.map(canonical).join(',')}]`
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const b64 = (b) => Buffer.from(b).toString('base64url')
const unb64 = (s) => Buffer.from(String(s || ''), 'base64url')
const sha = (s) => crypto.createHash('sha256').update(s).digest()

export function newSigningKey() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  return { pub: jwk.x, priv: jwk }
}
const pubObj = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
const privObj = (jwk) => crypto.createPrivateKey({ key: jwk, format: 'jwk' })
export const sign = (privJwk, what, data) => b64(crypto.sign(null, Buffer.from(`${what}|${canonical(data)}`), privObj(privJwk)))
export function verify(pub, what, data, sig) {
  try { return crypto.verify(null, Buffer.from(`${what}|${canonical(data)}`), pubObj(pub), unb64(sig)) } catch { return false }
}

/** The tag a PC of this agency announces on the office network: a hash of the agency id, nothing readable. */
export const agencyTag = (agencyId) => crypto.createHash('sha256').update('adal-agency-id|' + String(agencyId)).digest('hex').slice(0, 16)

// ── Anchor, certificate, revoked list ───────────────────────────────────────

/** The anchor (root → agency key). Its agency id, or throws. */
export function checkAnchor(anchor) {
  const p = anchor?.p
  if (!p || p.v !== 1 || !p.agency_id || !p.agency_pub) throw trustErr('No agency anchor')
  if (!roots().some(r => verify(r, 'adal-agency-anchor-v1', p, anchor.s))) throw trustErr('The agency anchor is not signed by Adal')
  return p
}
/** A certificate under that anchor, for that agency. Its payload, or throws. */
export function checkCert(anchor, cert, { agencyId, now = Date.now(), crl = null } = {}) {
  const a = checkAnchor(anchor)
  if (agencyId && a.agency_id !== agencyId) throw trustErr('A PC of another agency')
  const p = cert?.p
  if (!p || p.v !== 1 || p.agency_id !== a.agency_id || !/^[0-9a-f]{12}$/.test(p.pc_id || '') || !p.device_pub || !p.serial) throw trustErr('Not a certificate of this agency')
  if (!verify(a.agency_pub, 'adal-device-cert-v1', p, cert.s)) throw trustErr('The certificate is not signed by the agency')
  if (p.expires_at && now > Date.parse(p.expires_at)) throw trustErr('The certificate ran out')
  if (crl && isRevoked(crl, p)) throw trustErr('This PC was removed from the agency', { revoked: true })
  return p
}
/** The revoked list, checked (null when it is not the agency's). */
export function checkCRL(anchor, crl) {
  try {
    const a = checkAnchor(anchor)
    const p = crl?.p
    if (!p || p.v !== 1 || p.agency_id !== a.agency_id || !Number.isInteger(p.version) || !Array.isArray(p.revoked)) return null
    return verify(a.agency_pub, 'adal-agency-crl-v1', p, crl.s) ? crl : null
  } catch { return null }
}
export const isRevoked = (crl, certP) => (crl?.p?.revoked || []).some(r => r.serial === certP.serial || (r.pc_id && r.pc_id === certP.pc_id && (!r.before || Date.parse(certP.issued_at) <= Date.parse(r.before))))
export const crlVersion = (crl) => Number(crl?.p?.version) || 0

function trustErr(msg, extra = {}) { return Object.assign(new Error(msg), { status: 403, trust: true, ...extra }) }

// ── This PC's own (data/agency-trust.json) ──────────────────────────────────

/**
 *   device   { pub, priv }  this PC's device key (made once)
 *   anchor   the agency's anchor            cert   this PC's certificate
 *   crl      the newest revoked list seen   request  { id, at } a join asked for
 */
export class TrustStore {
  constructor(file = trustFile()) { this.file = file; this.j = null }
  read() {
    if (this.j) return this.j
    try { this.j = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.j = {} }
    if (!this.j.device?.priv?.d) { this.j.device = newSigningKey(); this.write() }
    return this.j
  }
  write(patch = {}) {
    if (!this.j) this.read()
    this.j = { ...this.j, ...patch }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.j, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    return this.j
  }
  get device() { return this.read().device }
  get anchor() { return this.read().anchor || null }
  get cert() { return this.read().cert || null }
  get crl() { return this.read().crl || null }
  agencyId() { return this.anchor?.p?.agency_id || null }
  /** Joined: a certificate of an anchored agency, with this PC's device key, not revoked. */
  ready() {
    try { const p = checkCert(this.anchor, this.cert, { crl: this.crl }); return p.device_pub === this.device.pub } catch { return false }
  }
  /** What the cloud sent once the join was approved (checked before it is kept). */
  adopt({ anchor, cert, crl }) {
    const p = checkCert(anchor, cert)
    if (p.device_pub !== this.device.pub) throw trustErr('That certificate is for another device key')
    this.write({ anchor, cert, crl: checkCRL(anchor, crl) || this.crl, request: null })
    return p
  }
  /** A newer revoked list (from the cloud or from another PC): kept. True when it was newer. */
  takeCRL(crl) {
    if (!this.anchor || !checkCRL(this.anchor, crl) || crlVersion(crl) <= crlVersion(this.crl)) return false
    this.write({ crl })
    return true
  }
  /** This PC itself is on the revoked list. */
  revokedHere() { return !!(this.cert && this.crl && isRevoked(this.crl, this.cert.p)) }
}

// ── Sealing (AES-256-GCM, numbered both ways) ───────────────────────────────

const iv = (dir, n) => { const b = Buffer.alloc(12); b.writeUInt32BE(dir, 0); b.writeBigUInt64BE(BigInt(n), 4); return b }
export function seal(key, dir, n, aad, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv(dir, n))
  c.setAAD(Buffer.from(aad))
  const body = Buffer.concat([c.update(plain), c.final()])
  return b64(Buffer.concat([c.getAuthTag(), body]))
}
export function open(key, dir, n, aad, box) {
  const buf = unb64(box)
  if (buf.length < 16) throw trustErr('Nothing sealed')
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv(dir, n))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(buf.subarray(0, 16))
  try { return Buffer.concat([d.update(buf.subarray(16)), d.final()]) } catch { throw trustErr('A call not sealed with this session') }
}
// (One byte first: 0 = JSON, 1 = a file's bytes.)
const packJSON = (o) => Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(o ?? null))])
const packRaw = (b) => Buffer.concat([Buffer.from([1]), Buffer.from(b)])
const unpack = (b) => (b[0] === 1 ? b.subarray(1) : JSON.parse(b.subarray(1).toString('utf8') || 'null'))
const C2S = 1, S2C = 2

function transcript(o) { return sha(canonical(o)).toString('hex') }
function sessionKey(ephPriv, theirEph, t) {
  let shared
  // (A weak one-time key — all zeros, a small-order point — does not derive: refused, not a crash.)
  try { shared = crypto.diffieHellman({ privateKey: ephPriv, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirEph }, format: 'jwk' }) }) } catch { throw trustErr('A bad one-time key') }
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(t, 'hex'), 'adal-pc-session-v1', 32))
}
function newEph() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
  return { priv: privateKey, pub: publicKey.export({ format: 'jwk' }).x }
}

const SESSION_FOR = 30 * 60 * 1000
const WINDOW = 4096

// ── The answering side ──────────────────────────────────────────────────────

/**
 * This PC answering other PCs. onCRL(crl): a newer revoked list came from a
 * PC (kept already; cut those sessions). Sessions live in memory: a restart
 * means a new handshake, nothing more.
 */
export class TrustServer {
  constructor(store, { now = () => Date.now(), onCRL = () => {}, log = console } = {}) {
    Object.assign(this, { store, now, onCRL, log })
    this.pending = new Map()   // sid → { key, t, peer, at }
    this.sessions = new Map()  // sid → { key, peer, at, max, seen:Set }
    this.refused = 0
  }
  get pcId() { return this.store.cert?.p?.pc_id }

  /** Step 1: their anchor + certificate + one-time key → ours, signed. */
  hello(b = {}) {
    const st = this.store
    if (!st.ready()) throw trustErr('This PC has no certificate of the agency yet', { status: 503 })
    // Their list newer than ours: taken first (then their certificate is checked against the newest).
    if (b.crl && st.takeCRL(b.crl)) this.crlChanged()
    let peer
    try { peer = checkCert(b.anchor, b.cert, { agencyId: st.agencyId(), now: this.now(), crl: st.crl }) } catch (e) { this.refused++; throw e }
    if (peer.pc_id === this.pcId) { this.refused++; throw trustErr('That is this PC') }
    if (!/^[A-Za-z0-9_-]{43}$/.test(b.eph || '') || !/^[A-Za-z0-9_-]{22}$/.test(b.nonce || '')) { this.refused++; throw trustErr('A bad hello') }
    const eph = newEph()
    const nonce = b64(crypto.randomBytes(16))
    const sid = b64(crypto.randomBytes(16))
    const t = transcript({ agency: st.agencyId(), c: b.cert.p.serial, s: st.cert.p.serial, ce: b.eph, se: eph.pub, cn: b.nonce, sn: nonce, sid })
    this.pending.set(sid, { key: sessionKey(eph.priv, b.eph, t), t, peer, at: this.now() })
    for (const [k, v] of this.pending) if (this.now() - v.at > 60000) this.pending.delete(k)
    return {
      sid, anchor: st.anchor, cert: st.cert, eph: eph.pub, nonce, sig: sign(st.device.priv, 'adal-pc-auth-v1|server', { t }),
      ...(crlVersion(st.crl) > Number(b.crl_version || crlVersion(b.crl)) ? { crl: st.crl } : {}),
    }
  }

  /** Step 2: their signature over the same conversation → the session is on. */
  prove(b = {}) {
    const p = this.pending.get(String(b.sid || ''))
    if (!p) { this.refused++; throw trustErr('No such handshake (start again)', { status: 401 }) }
    this.pending.delete(b.sid)
    if (!verify(p.peer.device_pub, 'adal-pc-auth-v1|client', { t: p.t }, b.sig)) { this.refused++; throw trustErr('That PC does not hold the key of its certificate') }
    if (b.crl && this.store.takeCRL(b.crl)) this.crlChanged()
    if (isRevoked(this.store.crl, p.peer)) { this.refused++; throw trustErr('This PC was removed from the agency', { revoked: true }) }
    this.sessions.set(b.sid, { key: p.key, peer: p.peer, at: this.now(), max: 0, seen: new Set() })
    return { ok: true, pc_id: this.pcId }
  }

  /** A sealed call: the session, the call opened (or throws). */
  openCall(header, method, urlPath, box) {
    const [sid, ns] = String(header || '').split('.')
    const s = this.sessions.get(sid)
    if (!s || this.now() - s.at > SESSION_FOR) { this.sessions.delete(sid); throw trustErr('No such session (start again)', { status: 401, session: 'unknown' }) }
    const n = Number(ns)
    if (!Number.isSafeInteger(n) || n < 1 || s.seen.has(n) || n <= s.max - WINDOW) { this.refused++; throw trustErr('That call came before (refused)', { status: 401, session: 'replay' }) }
    const plain = open(s.key, C2S, n, `${sid}|${method}|${urlPath}|${n}`, box || '')
    s.seen.add(n)
    if (n > s.max) { s.max = n; for (const x of s.seen) if (x <= n - WINDOW) s.seen.delete(x) }
    const body = plain.length ? unpack(plain) : undefined
    return { session: s, sid, n, body }
  }
  sealAnswer(sid, n, s, payload, { raw = false } = {}) {
    return { box: seal(s.key, S2C, n, `${sid}|answer|${n}`, raw ? packRaw(payload) : packJSON(payload)) }
  }

  /** A newer revoked list: every session of a PC on it ends now. */
  crlChanged() {
    this.cutRevoked()
    try { this.onCRL(this.store.crl) } catch {}
  }
  cutRevoked() { for (const [sid, s] of this.sessions) if (isRevoked(this.store.crl, s.peer)) this.sessions.delete(sid) }
  cutPC(pcId) { for (const [sid, s] of this.sessions) if (s.peer.pc_id === pcId) this.sessions.delete(sid) }
}

// ── The calling side ────────────────────────────────────────────────────────

export class TrustClient {
  constructor(store, { fetch: f = fetch, now = () => Date.now(), onCRL = () => {} } = {}) {
    Object.assign(this, { store, f, now, onCRL })
    this.sessions = new Map()  // base url → { sid, key, n, peer, at }
    this.certified = new Set() // addresses that showed a certificate once (never asked without one again)
  }
  wasCertified(url) { return this.certified.has(url) }
  /** The PC at that address, as its certificate says (after a handshake). */
  peerAt(url) { return this.sessions.get(url)?.peer || null }

  async handshake(url, { timeout = 8000 } = {}) {
    const st = this.store
    if (!st.ready()) throw trustErr('This PC has no certificate of the agency yet', { status: 503 })
    const eph = newEph()
    const nonce = b64(crypto.randomBytes(16))
    const post = async (p, body) => {
      const r = await this.f(`${url}/api/sync/auth/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(j.error || `${url} answered ${r.status}`), { status: r.status, trust: true, revoked: j.revoked, suspended: j.suspended })
      return j
    }
    const h = await post('hello', { anchor: st.anchor, cert: st.cert, eph: eph.pub, nonce, crl_version: crlVersion(st.crl) })
    if (h.crl && st.takeCRL(h.crl)) { try { this.onCRL(st.crl) } catch {} }
    if (st.revokedHere()) throw trustErr('This PC was removed from the agency', { revoked: true })
    const peer = checkCert(h.anchor, h.cert, { agencyId: st.agencyId(), now: this.now(), crl: st.crl })
    if (peer.pc_id === st.cert.p.pc_id) throw trustErr('That is this PC')
    const t = transcript({ agency: st.agencyId(), c: st.cert.p.serial, s: peer.serial, ce: eph.pub, se: h.eph, cn: nonce, sn: h.nonce, sid: h.sid })
    if (!verify(peer.device_pub, 'adal-pc-auth-v1|server', { t }, h.sig)) throw trustErr('That PC does not hold the key of its certificate')
    const key = sessionKey(eph.priv, h.eph, t)
    await post('prove', { sid: h.sid, sig: sign(st.device.priv, 'adal-pc-auth-v1|client', { t }), ...(crlVersion(st.crl) > crlVersion(h.crl) ? { crl: st.crl } : {}) })
    const s = { sid: h.sid, key, n: 0, peer, at: this.now() }
    this.sessions.set(url, s)
    this.certified.add(url)
    return s
  }

  /** One sealed call to that PC (a handshake first when there is no session). */
  async call(url, method, urlPath, body, { timeout = 30000, raw = false, again = true } = {}) {
    let s = this.sessions.get(url)
    if (!s || this.now() - s.at > SESSION_FOR - 60000) s = await this.handshake(url)
    const n = ++s.n
    const box = seal(s.key, C2S, n, `${s.sid}|${method}|${urlPath}|${n}`, body === undefined || body === null ? Buffer.alloc(0) : packJSON(body))
    const get = method === 'GET' || method === 'HEAD'
    const r = await this.f(`${url}${urlPath}`, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { 'x-adal-session': `${s.sid}.${n}`, ...(get ? { 'x-adal-box': box } : { 'content-type': 'application/json' }) },
      body: get ? undefined : JSON.stringify({ box }),
    })
    const j = await r.json().catch(() => ({}))
    if (j.box) {
      const out = unpack(open(s.key, S2C, n, `${s.sid}|answer|${n}`, j.box))
      if (!r.ok) throw Object.assign(new Error(out?.error || `${url} answered ${r.status}`), { status: r.status, suspended: out?.suspended })
      return out
    }
    if (r.status === 401 && j.session && again) { this.sessions.delete(url); return this.call(url, method, urlPath, body, { timeout, raw, again: false }) }
    throw Object.assign(new Error(j.error || `${url} answered ${r.status}`), { status: r.status, trust: !!j.trust, revoked: j.revoked, suspended: j.suspended })
  }
  forget(url) { if (url) this.sessions.delete(url); else this.sessions.clear() }
}
