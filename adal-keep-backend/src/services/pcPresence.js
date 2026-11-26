/**
 * pcPresence.js — the office's PCs know each other by an id that never changes,
 * not by IP (2026-11-23, the owner: a Companion kept Main's old address, Main
 * moved from .4 to .12, a hotspot address and a Tailscale one were tried).
 *
 *   Every PC (the main PC, each Companion — adal-companion presence.go) says on
 *   UDP 45454 every 5 s:
 *     ADAL_KEEP_PC_V1|<agency tags>|<pc id>|<port>|<role>|<name>|<flags>
 *   (tags: hashes of the main PC's number, never the number; role main|pc|companion;
 *   flags: "randmac" when its Wi-Fi uses random hardware addresses).
 *   Every PC keeps a live map pc id → the address the message came from now,
 *   refreshed by every message: a PC that gets a new address is found at its
 *   next message, and a failed connection looks here first.
 *   Only this agency's PCs (a tag of ours), only addresses of this PC's own
 *   network (never Tailscale 100.64/10, link-local, another subnet).
 *   The id is permanent (sync/identity.js: data/sync-id.json, made once).
 *
 * The address book (2026-11-26, the owner: hundreds of agencies, a Main that moved .6 → .3 → .5 in two
 * days, every move cost sweeps and lost copies; no account or setup per agency):
 *   - Signed: a last field s1:<time>:<its addresses>:<HMAC> with a key made from the agency's backup
 *     key (every PC with a copy has it, another agency's PC never). The tag (a hash of a number anyone
 *     may know) only sorts; the signature decides. A signed message counts only from one of the
 *     addresses it names (a copy replayed from elsewhere is nothing), never older than the last one of
 *     that PC; a PC once heard signed is never taken unsigned again. Unsigned ones (older programs, or
 *     no key here yet) count as before, unless ADAL_PRESENCE_STRICT=1.
 *   - Said at once when this PC's addresses change (looked at every 2 s), three times, and online in
 *     the next heartbeat (keep_meta /_pc lan, cloudSync.js), not only every 5 s.
 *   Older programs read the first fields only. Off: ADAL_PRESENCE_SIGN=0 (unsigned, as before).
 *   A network card (MAC) is only a hint: Windows' "random hardware addresses"
 *   change a Wi-Fi card's MAC (randomMac() warns when it is on here).
 */
import os from 'os'
import crypto from 'crypto'
import { lanUsable, getLanAddresses } from './discovery.js'

export const PRESENCE = 'ADAL_KEEP_PC_V1'
export const EVERY_MS = Number(process.env.ADAL_PRESENCE_MS) || 5000
export const FRESH_MS = Number(process.env.ADAL_PRESENCE_FRESH_MS) || 20000
const ID = /^[0-9a-z-]{6,40}$/i

export function message({ tags = [], pcId, port, role = 'pc', name = '', randomMac = false }) {
  return [PRESENCE, tags.filter(Boolean).join(','), pcId, port, role, String(name).replace(/[|\n]/g, ' ').slice(0, 60), randomMac ? 'randmac' : ''].join('|')
}

export function parse(text) {
  const p = String(text || '').trim().split('|')
  if (p[0] !== PRESENCE || p.length < 5) return null
  const port = Number(p[3])
  if (!ID.test(p[2] || '') || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const out = { tags: (p[1] || '').split(',').filter(Boolean), pcId: p[2], port, role: ['main', 'pc', 'companion'].includes(p[4]) ? p[4] : 'pc', name: p[5] || '', randomMac: p[6] === 'randmac' }
  const s = /^s1:(\d{10,13}):([0-9.,]{0,200}):([0-9a-f]{32})$/.exec(p[7] || '')
  if (s) out.sig = { ts: Number(s[1]), addrs: s[2].split(',').filter(Boolean), mac: s[3], body: p.slice(0, 7).join('|') + `|s1:${s[1]}:${s[2]}` }
  return out
}

// ── Signed ────────────────────────────────────────────────────────────────
/** The announce key from the agency's backup key (the same in adal-companion presence.go). */
export const signKey = (backupKey) => backupKey ? crypto.createHmac('sha256', String(backupKey)).update('adal-presence-v1').digest() : null
const macOf = (key, body) => crypto.createHmac('sha256', key).update(body).digest('hex').slice(0, 32)
export const signOn = () => process.env.ADAL_PRESENCE_SIGN !== '0'
/** The message with its signature (its addresses named), or as it was without a key. */
export function sign(text, key, addrs = getLanAddresses(), ts = Date.now()) {
  if (!key || !signOn()) return text
  const p = text.split('|'); while (p.length < 7) p.push('')
  const body = p.slice(0, 7).join('|') + `|s1:${ts}:${addrs.filter(a => /^[0-9.]+$/.test(a)).slice(0, 8).join(',')}`
  return `${body}:${macOf(key, body)}`
}
const SKEW_MS = 15 * 60e3
/** The answer to a Companion's question "are you ours?" (a fresh nonce): only a PC with the agency's key has it. */
export const proofOf = (key, nonce, pcId) => key ? macOf(key, `proof|${nonce}|${pcId}`) : null

/** The same /24 as one of this PC's own addresses. */
export function onOwnNet(ip, mine = getLanAddresses()) {
  const n = (a) => String(a).split('.').slice(0, 3).join('.')
  return mine.some(a => n(a) === n(ip))
}

/** The live map: pc id → where it is now. */
export class Presence {
  constructor({ ownId = () => '', tags = () => [], mine = () => getLanAddresses(), now = () => Date.now(), key = () => null } = {}) {
    this.ownId = ownId; this.tags = tags; this.mine = mine; this.now = now; this.key = key
    this.map = new Map()
    this.ignored = 0
    this.signedAt = new Map()   // pc id → the newest signed time heard from it
  }
  /** true: signed by our agency; false: refused; null: not signed (or no key here to tell). */
  checked(m, ip) {
    const key = this.key()
    if (!m.sig) return this.signedAt.has(m.pcId) || process.env.ADAL_PRESENCE_STRICT === '1' ? false : null
    if (!key) return null
    const good = m.sig.mac.length === 32 && crypto.timingSafeEqual(Buffer.from(macOf(key, m.sig.body)), Buffer.from(m.sig.mac))
    if (!good || !m.sig.addrs.includes(ip) || Math.abs(this.now() - m.sig.ts) > SKEW_MS || m.sig.ts < (this.signedAt.get(m.pcId) || 0) - 60e3) return false
    this.signedAt.set(m.pcId, Math.max(m.sig.ts, this.signedAt.get(m.pcId) || 0))
    return true
  }
  /** A message heard from fromIp: kept (and returned) only when it is one of this agency's PCs on this network. */
  heard(text, fromIp) {
    const m = parse(text)
    if (!m) return null
    const ip = String(fromIp || '').replace(/^::ffff:/, '')
    const ours = this.tags()
    if (m.pcId === this.ownId() || !ours.length || !m.tags.some(t => ours.includes(t)) || !lanUsable(ip) || !onOwnNet(ip, this.mine())) { this.ignored++; return null }
    const signed = this.checked(m, ip)
    if (signed === false) { this.ignored++; this.refused = (this.refused || 0) + 1; return null }
    const before = this.map.get(m.pcId)
    const { sig, ...rest } = m
    const e = { ...rest, ip, signed: !!signed, url: `http://${ip}:${m.port}`, at: this.now(), moved: !!before && before.ip !== ip ? before.ip : null }
    this.map.set(m.pcId, e)
    return e
  }
  /** Where that PC is now (heard within FRESH_MS), or null. */
  get(pcId, maxAge = FRESH_MS) {
    const e = this.map.get(pcId)
    return e && this.now() - e.at <= maxAge ? e : null
  }
  urlsOf(pcId) { const e = this.get(pcId); return e ? [e.url] : [] }
  /** Every PC heard lately (the main role first). */
  live(maxAge = FRESH_MS) { return [...this.map.values()].filter(e => this.now() - e.at <= maxAge).sort((a, b) => (b.role === 'main') - (a.role === 'main')) }
  /** Forget a PC's address after a failed connection (its next message brings the new one). */
  failed(pcId) { const e = this.map.get(pcId); if (e) this.map.set(pcId, { ...e, at: -Infinity }) }
}

/**
 * This PC's Wi-Fi card uses a random (locally administered) hardware address:
 * Windows "Random hardware addresses" is on, and the card's MAC may change.
 */
export function randomMac(ifaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || !lanUsable(a.address) || !a.mac || a.mac === '00:00:00:00:00:00') continue
      if (parseInt(a.mac.slice(0, 2), 16) & 2) out.push({ name, mac: a.mac })
    }
  }
  return out
}

let presence = null
export const presenceNow = () => presence

/**
 * Starts it on this PC: says who it is every EVERY_MS (through send: the discovery
 * socket on 45454), and hears the others (the discovery socket hands each message to heard).
 */
export function startPresence({ send, ownId, tags, port, role, name = os.hostname(), log = console, key = () => null, onMoved = () => {}, addrs = () => getLanAddresses() } = {}) {
  if (presence || process.env.ADAL_PRESENCE === '0') return presence
  presence = new Presence({ ownId, tags, key })
  const rnd = randomMac()
  if (rnd.length) log.warn?.(`[presence] ${rnd.map(r => `${r.name} ${r.mac}`).join(', ')}: random hardware addresses are ON here — this PC's network card may change; the other PCs find it by its id, not its card`)
  const say = () => { try { const t = tags(); if (t.length) send(sign(message({ tags: t, pcId: ownId(), port: port(), role: role(), name, randomMac: rnd.length > 0 }), key(), addrs())) } catch {} }
  say()
  const t = setInterval(say, EVERY_MS); t.unref?.()
  // This PC's addresses changed: said at once (three times: one may be lost while the network settles).
  let was = addrs().join(',')
  const w = setInterval(() => {
    const now = addrs().join(',')
    if (now === was) return
    log.log?.(`[presence] this PC's address changed: ${was || 'none'} → ${now || 'none'} — said at once`)
    was = now
    say(); for (const ms of [1000, 3000]) setTimeout(say, ms).unref?.()
    try { onMoved(now) } catch {}
  }, Number(process.env.ADAL_ADDR_WATCH_MS) || 2000); w.unref?.()
  presence.stop = () => { clearInterval(t); clearInterval(w) }
  return presence
}
export function stopPresence() { presence?.stop?.(); presence = null }

/** The agency's tags this PC says and listens to: its main PC's number(s), hashed. */
export async function agencyTagsHere() {
  const { agencyTag } = await import('./lanRelease.js')
  const nums = [process.env.ADAL_AGENCY_NUMBER]
  try { const mp = await import('./mainPC.js'); if (!mp.notMainPC()) nums.push(mp.pcNumber()) } catch {}
  try { nums.push((await import('./subscription.js')).pcNumber()) } catch {}
  return [...new Set(nums.filter(n => /\d{5,6}/.test(String(n || ''))).map(agencyTag))]
}

/** main.js: presence on this PC, on the discovery socket. */
export async function startOnThisPC({ port, role }) {
  const disco = await import('./discovery.js')
  const { pcId } = await import('./sync/identity.js')
  let tags = await agencyTagsHere()
  const t = setInterval(() => agencyTagsHere().then(x => { tags = x }).catch(() => {}), 10 * 60 * 1000); t.unref?.()
  const { getSecret } = await import('./secretStore.js')
  let key = null, keyFrom = null
  const keyNow = () => { const k = getSecret('backup_password') || null; if (k !== keyFrom) { keyFrom = k; key = signKey(k) } return key }
  const p = startPresence({
    send: (text) => disco.broadcastOnDiscovery(text), ownId: pcId, tags: () => tags, port, role, key: keyNow,
    onMoved: () => import('./cloudSync.js').then(c => c.beatSoon?.()).catch(() => {}),
  })
  disco.onPresence((text, rinfo) => {
    const e = p?.heard(text, rinfo.address)
    if (e?.moved) console.log(`[presence] ${e.name || e.pcId} (${e.pcId}) moved from ${e.moved} to ${e.ip}`)
  })
  return p
}
