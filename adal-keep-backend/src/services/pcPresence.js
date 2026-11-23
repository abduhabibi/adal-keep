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
 *   A network card (MAC) is only a hint: Windows' "random hardware addresses"
 *   change a Wi-Fi card's MAC (randomMac() warns when it is on here).
 */
import os from 'os'
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
  return { tags: (p[1] || '').split(',').filter(Boolean), pcId: p[2], port, role: ['main', 'pc', 'companion'].includes(p[4]) ? p[4] : 'pc', name: p[5] || '', randomMac: p[6] === 'randmac' }
}

/** The same /24 as one of this PC's own addresses. */
export function onOwnNet(ip, mine = getLanAddresses()) {
  const n = (a) => String(a).split('.').slice(0, 3).join('.')
  return mine.some(a => n(a) === n(ip))
}

/** The live map: pc id → where it is now. */
export class Presence {
  constructor({ ownId = () => '', tags = () => [], mine = () => getLanAddresses(), now = () => Date.now() } = {}) {
    this.ownId = ownId; this.tags = tags; this.mine = mine; this.now = now
    this.map = new Map()
    this.ignored = 0
  }
  /** A message heard from fromIp: kept (and returned) only when it is one of this agency's PCs on this network. */
  heard(text, fromIp) {
    const m = parse(text)
    if (!m) return null
    const ip = String(fromIp || '').replace(/^::ffff:/, '')
    const ours = this.tags()
    if (m.pcId === this.ownId() || !ours.length || !m.tags.some(t => ours.includes(t)) || !lanUsable(ip) || !onOwnNet(ip, this.mine())) { this.ignored++; return null }
    const before = this.map.get(m.pcId)
    const e = { ...m, ip, url: `http://${ip}:${m.port}`, at: this.now(), moved: !!before && before.ip !== ip ? before.ip : null }
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
export function startPresence({ send, ownId, tags, port, role, name = os.hostname(), log = console } = {}) {
  if (presence || process.env.ADAL_PRESENCE === '0') return presence
  presence = new Presence({ ownId, tags })
  const rnd = randomMac()
  if (rnd.length) log.warn?.(`[presence] ${rnd.map(r => `${r.name} ${r.mac}`).join(', ')}: random hardware addresses are ON here — this PC's network card may change; the other PCs find it by its id, not its card`)
  const say = () => { try { const t = tags(); if (t.length) send(message({ tags: t, pcId: ownId(), port: port(), role: role(), name, randomMac: rnd.length > 0 })) } catch {} }
  say()
  const t = setInterval(say, EVERY_MS); t.unref?.()
  presence.stop = () => clearInterval(t)
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
  const p = startPresence({ send: (text) => disco.broadcastOnDiscovery(text), ownId: pcId, tags: () => tags, port, role })
  disco.onPresence((text, rinfo) => {
    const e = p?.heard(text, rinfo.address)
    if (e?.moved) console.log(`[presence] ${e.name || e.pcId} (${e.pcId}) moved from ${e.moved} to ${e.ip}`)
  })
  return p
}
