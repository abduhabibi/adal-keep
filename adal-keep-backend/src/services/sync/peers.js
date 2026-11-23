/**
 * peers.js — the agency's PCs find each other on the office network, with or
 * without the main PC (asked on 2026-11-20: "Companions must see each other").
 *
 * Every PC of the agency (the main PC and every Companion) answers and asks:
 *
 *   ask    (UDP broadcast to DISCOVERY_PORT, 45454)
 *          ADAL_KEEP_PEERS_V1|<tags>|<pc_id>|<port>|<ips>|<macs>|<name>
 *   answer (unicast back to the asker)
 *          ADAL_KEEP_PEER_V1|<tags>|<pc_id>|<port>|<ips>|<macs>|<name>
 *
 * <tags> are the agency's tags: a hash of the agency's first PC (the slot-1 row
 * of sync_pcs, the same on every PC of the agency) and a hash of the main PC's
 * number (lanRelease.agencyTag, the scheme the update sharing uses). Nothing
 * readable about the agency is broadcast. A message is taken only when
 *   • one of its tags is this agency's, and
 *   • its pc_id is a PC on this agency's own list (sync_pcs), not removed or
 *     suspended, and not this PC.
 * Another agency's PC on the same Wi-Fi is never listened to (and even if it
 * were, it could not sync: every /sync call carries the PC's key, checked
 * against sync_pcs).
 *
 * When the broadcast does not reach (Wi-Fi client isolation, another subnet)
 * the neighbour table (ARP) is the second way: each PC writes its network cards
 * (MACs) in its own sync_pcs row; an address whose card is a peer's is tried.
 *
 * Both only add addresses to try; node.reach() still checks /sync/hello
 * answers as that very PC (its pc_id) with this agency's key.
 *
 * Equal PCs (ADAL_EQUAL_PCS, trust.js): the tag is a hash of the agency's id
 * (trust.agencyTag) — while the PCs move over, next to the two above; strict,
 * alone. A PC not on the list yet is listened to then (it joined from the
 * cloud a moment ago): only its certificate, in the handshake, lets it in.
 */
import dgram from 'dgram'
import os from 'os'
import crypto from 'crypto'
import fs from 'fs'
import { execFile } from 'child_process'
import { agencyTag } from './trust.js'

export const PEER_ASK = 'ADAL_KEEP_PEERS_V1'
export const PEER_HERE = 'ADAL_KEEP_PEER_V1'
const FOUND_FOR = 30 * 60 * 1000

export const rootTag = (pcId) => crypto.createHash('sha256').update('adal-sync-agency|' + String(pcId)).digest('hex').slice(0, 16)
export const numberTag = (number) => crypto.createHash('sha256').update('adal-agency|' + String(number).replace(/\D/g, '')).digest('hex').slice(0, 16)

export const normMAC = (s) => {
  const m = String(s || '').trim().toLowerCase().replace(/-/g, ':')
  if (!/^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/.test(m)) return ''
  const n = m.split(':').map(x => x.padStart(2, '0')).join(':')
  return n === '00:00:00:00:00:00' || n === 'ff:ff:ff:ff:ff:ff' ? '' : n
}

/** Linux /proc/net/arp → { ip: mac }. */
export function parseProcArp(text) {
  const out = {}
  for (const [i, line] of String(text || '').split('\n').entries()) {
    const f = line.trim().split(/\s+/)
    if (i === 0 || f.length < 4 || f[2] === '0x0') continue
    const m = normMAC(f[3]); if (m) out[f[0]] = m
  }
  return out
}
/** "arp -a" (Windows, macOS) → { ip: mac }. */
export function parseArpA(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const words = line.replace(/[()]/g, ' ').trim().split(/\s+/)
    let ip = '', mac = ''
    for (const w of words) {
      if (!ip && /^\d+\.\d+\.\d+\.\d+$/.test(w)) ip = w
      else if (!mac) mac = normMAC(w)
    }
    if (ip && mac) out[ip] = mac
  }
  return out
}
/** This PC's neighbour table (no window: arp runs hidden on Windows). */
export function neighbourTable() {
  if (process.platform === 'linux') {
    try { return Promise.resolve(parseProcArp(fs.readFileSync('/proc/net/arp', 'utf8'))) } catch { return Promise.resolve({}) }
  }
  return new Promise((resolve) => {
    try {
      execFile('arp', ['-a'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? {} : parseArpA(out)))
    } catch { resolve({}) }
  })
}

/** Where to shout: the limited broadcast and each network's own broadcast address. */
export function broadcastAddrs() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue
    if (a.internal || !a.netmask) continue
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number)
    out.add(ip.map((n, i) => (n | (~m[i] & 255))).join('.'))
  }
  if (process.env.ADAL_PEER_TARGETS) for (const t of process.env.ADAL_PEER_TARGETS.split(',')) if (t.trim()) out.add(t.trim())
  return [...out]
}

export class PeerFinder {
  /**
   * node: the SyncNode. port: the UDP port every PC answers on. macs(): this
   * PC's network cards. neighbours(): the ARP table. udp: dgram (tests).
   */
  constructor(node, { port = 45454, macs = () => [], neighbours = neighbourTable, targets = broadcastAddrs, udp = dgram, log = console } = {}) {
    Object.assign(this, { node, port, macs, neighbours, targets, udp, log })
    this.found = new Map()     // pc_id → { urls, macs, at, name }
    this.ignored = 0           // messages not of this agency (tests, the status)
    this.tags = []
    this.known = new Map()     // pc_id → row (this agency's PCs, not cut off)
  }

  /** The agency's tags and its PCs (after every change to sync_pcs / sync_role). */
  async refresh() {
    const pcs = await this.node.roles.pcs()
    this.known = new Map(pcs.filter(p => !p.revoked_at && !p.suspended_at).map(p => [p.pc_id, p]))
    const tags = []
    const first = pcs.filter(p => Number.isFinite(Number(p.slot))).sort((a, b) => Number(a.slot) - Number(b.slot) || String(a.joined_at || '').localeCompare(String(b.joined_at || '')))[0]
    if (first) tags.push(rootTag(first.pc_id))
    const num = this.node.roles.licence()?.pcNumber
    if (num) tags.push(numberTag(num))
    const aid = this.node.trust?.store.agencyId()
    this.agencyTag = aid ? agencyTag(aid) : null
    this.tags = aid ? (this.node.strict ? [this.agencyTag] : [this.agencyTag, ...tags]) : tags
    return tags
  }

  line(kind) {
    const n = this.node
    const ips = (n.addresses() || []).map(a => (typeof a === 'string' ? a : a?.address)).filter(Boolean).slice(0, 6)
    return [kind, this.tags.join(','), n.pcId, String(n.port), ips.join(','), (this.macs() || []).join(','), String(n.name || '').replace(/[|\r\n]/g, ' ').slice(0, 60)].join('|')
  }

  /** A message heard (an ask or an answer). Returns the answer to send back, or null. */
  heard(text, from = {}) {
    const p = String(text || '').trim().split('|')
    if (p[0] !== PEER_ASK && p[0] !== PEER_HERE) return null
    const [kind, tags, pcId, port, ips, macs, name] = p
    if (!this.tags.length || !String(tags || '').split(',').some(t => t && this.tags.includes(t))) { this.ignored++; return null }
    if (!/^[0-9a-f]{12}$/.test(pcId || '') || pcId === this.node.pcId) return null
    if (!this.known.has(pcId) && !(this.node.trust && this.agencyTag && String(tags || '').split(',').includes(this.agencyTag))) { this.ignored++; return null }
    const httpPort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : 4000
    const urls = []
    const add = (ip) => { if (/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') && !ip.startsWith('169.254.')) { const u = `http://${ip}:${httpPort}`; if (!urls.includes(u)) urls.push(u) } }
    add(from.address)
    for (const ip of String(ips || '').split(',')) add(ip.trim())
    this.found.set(pcId, { urls, macs: String(macs || '').split(',').map(normMAC).filter(Boolean), at: Date.now(), name: name || '' })
    return kind === PEER_ASK && this.tags.length ? this.line(PEER_HERE) : null
  }

  /** The addresses heard lately for that PC (newest first). */
  urlsOf(pcId) {
    const f = this.found.get(pcId)
    return f && Date.now() - f.at < FOUND_FOR ? f.urls : []
  }

  /** Ask the office network who of the agency is there; the answers land in found. */
  async search({ wait = 1500 } = {}) {
    if (!this.tags.length) return 0
    const before = new Set([...this.found].filter(([, f]) => Date.now() - f.at < 2000).map(([k]) => k))
    await new Promise((resolve) => {
      let sock
      try { sock = this.udp.createSocket({ type: 'udp4', reuseAddr: true }) } catch { return resolve() }
      const done = () => { try { sock.close() } catch {} ; resolve() }
      sock.on('error', done)
      sock.on('message', (msg, rinfo) => { try { this.heard(msg.toString('utf8'), rinfo) } catch {} })
      sock.bind(0, () => {
        try { sock.setBroadcast(true) } catch {}
        const buf = Buffer.from(this.line(PEER_ASK), 'utf8')
        for (const t of this.targets()) { try { sock.send(buf, 0, buf.length, this.port, t, () => {}) } catch {} }
        setTimeout(done, wait).unref?.()
      })
    })
    return [...this.found].filter(([k, f]) => !before.has(k) && Date.now() - f.at < wait + 3000).length
  }

  /** Addresses on this network whose network card is that PC's (ARP). */
  async byCard(pc) {
    const cards = new Set([...(pc.macs || []), ...(this.found.get(pc.pc_id)?.macs || [])].map(normMAC).filter(Boolean))
    if (!cards.size) return []
    const table = await this.neighbours().catch(() => ({}))
    const port = Number(pc.port) || 4000
    return Object.entries(table || {}).filter(([, mac]) => cards.has(mac)).map(([ip]) => `http://${ip}:${port}`)
  }
}

/** The network cards of these addresses (discovery.macsOf), for this PC's sync_pcs row. */
export async function ownMacs() {
  try { return (await import('../discovery.js')).macsOf() } catch { return [] }
}
