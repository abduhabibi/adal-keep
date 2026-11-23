/**
 * discovery.js — LAN auto-discovery so an Employee PC finds the Server PC
 * without anybody typing an IP address.
 *
 * Why a UDP broadcast and not mDNS
 * --------------------------------
 * mDNS needs Bonjour (unreliable when the Windows firewall profile is
 * "Public") and a service name Windows exposes inconsistently. A raw UDP
 * broadcast on a fixed port needs no service, no driver and no admin
 * rights: the Companion app shouts `ADAL_KEEP_DISCOVER_V1` to
 * 255.255.255.255:45454, every Adal Keep server on the LAN answers with its
 * own reachable URL, and the Companion caches the first answer it gets.
 *
 * Protocol (keep in sync with adal-companion/discovery.go)
 * -------------------------------------------------------
 *   request  -> "ADAL_KEEP_DISCOVER_V1"                (UTF-8, UDP 45454)
 *   response -> "ADAL_KEEP_SERVER_V1|<port>|<lan-ip>|<name>|<lan-ip>,<lan-ip>,...|<mac>,<mac>,..."
 *
 * <mac> are this PC's network cards (the one of <lan-ip> first). A Companion
 * remembers the main PC's card and its number, and finds it again by the card
 * in its neighbour table (ARP) when the router hands out new addresses.
 *
 * <lan-ip> is the best LAN address (the one on the asking PC's network first);
 * the last field lists every LAN address (older Companions ignore it). A
 * Tailscale/CGNAT (100.64.0.0/10) or 169.254 address is never advertised: on
 * 2026-11-18 a main PC answered with its Tailscale IP and the Companions on its
 * Wi-Fi could not reach it. With no LAN address the field is empty and the
 * Companion uses the reply's own source address.
 */

import dgram from 'dgram'
import os from 'os'

export const DISCOVERY_PORT = 45454
export const DISCOVERY_REQUEST = 'ADAL_KEEP_DISCOVER_V1'
export const DISCOVERY_RESPONSE = 'ADAL_KEEP_SERVER_V1'

let responder = null
// The agency's PCs asking for each other (services/sync/peers.js): every PC answers those.
let peerHandler = null
/** fn(text, rinfo) → the answer to send back, or null. */
export function onPeerMessage(fn) { peerHandler = typeof fn === 'function' ? fn : null }
// Every PC saying who it is (services/pcPresence.js).
let presenceHandler = null
export function onPresence(fn) { presenceHandler = typeof fn === 'function' ? fn : null }
/** One message to every PC of this PC's networks on the discovery port (the responder's socket). */
export function broadcastOnDiscovery(text, { port = responder?.port || DISCOVERY_PORT } = {}) {
  const sock = responder?.sock
  if (!sock) return false
  const buf = Buffer.from(text, 'utf8')
  const to = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal || !a.netmask || !lanUsable(a.address)) continue
    const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number)
    to.add(ip.map((n, i) => (n | (~m[i] & 255))).join('.'))
  }
  for (const t of String(process.env.ADAL_PRESENCE_TO || '').split(',').map(x => x.trim()).filter(Boolean)) to.add(t)
  for (const addr of to) { const [h, p] = addr.includes(':') ? addr.split(':') : [addr, port]; sock.send(buf, Number(p), h, () => {}) }
  return true
}

/**
 * Every non-internal IPv4 address this machine can be reached on.
 * Sorted so that real LAN ranges (192.168.x.x / 10.x.x.x / 172.16-31.x.x)
 * come before virtual-adapter noise (WSL 172.17-31, VirtualBox 192.168.56,
 * Docker bridges). Windows machines routinely have five of these.
 * @returns {string[]}
 */
/**
 * This PC's office-network addresses, best first. Never Tailscale / carrier NAT
 * (100.64.0.0/10) or link-local (169.254): another PC of the office cannot reach
 * them (2026-11-23: a Companion timed out copying from Main's 100.89.x address).
 * withTailscale: the remote-access code that wants that address too.
 */
export function getLanAddresses({ withTailscale = false } = {}) {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`
      if (family !== 'IPv4' || a.internal) continue
      if (!a.address || a.address.startsWith('169.254.')) continue // APIPA = no LAN
      if (!withTailscale && isCgnat(a.address)) continue
      out.push({ address: a.address, name })
    }
  }
  const score = (x) => {
    const a = x.address
    let s = 0
    if (a.startsWith('192.168.')) s = 100
    else if (a.startsWith('10.')) s = 90
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) s = 80
    // Virtual adapters are the classic "wrong IP on the sticker" trap.
    if (/vmware|virtualbox|vbox|hyper-v|docker|wsl|tailscale|zerotier/i.test(x.name || '')) s -= 60
    if (a.startsWith('192.168.56.')) s -= 30 // VirtualBox host-only default
    if (isCgnat(a)) s -= 200 // Tailscale / carrier NAT: never the LAN
    return s
  }
  return out.sort((a, b) => score(b) - score(a)).map((x) => x.address)
}

/**
 * The network cards (MAC addresses) of these addresses, in the same order,
 * each once: how a Companion recognises this PC whatever address it has.
 */
export function macsOf(addresses = getLanAddresses(), ifaces = os.networkInterfaces()) {
  const byIp = new Map()
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of addrs || []) if (a?.address && a.mac && a.mac !== '00:00:00:00:00:00') byIp.set(a.address, a.mac.toLowerCase())
  }
  const out = []
  for (const ip of addresses) { const m = byIp.get(ip); if (m && !out.includes(m)) out.push(m) }
  return out
}

/** 100.64.0.0/10: Tailscale and carrier-grade NAT, never reachable on the LAN. */
/** An address another PC of the office can use: not Tailscale/CGNAT, link-local, loopback or empty. */
export function lanUsable(ip) {
  const a = String(ip || '').replace(/^\[|\]$/g, '')
  if (!a || a.startsWith('169.254.') || /^fe80:/i.test(a) || a === '0.0.0.0') return false
  return !isCgnat(a)
}
/**
 * Another PC's addresses, the ones on this PC's own network first (the same /24 as one of
 * this PC's addresses), the unusable ones (Tailscale, link-local) left out.
 */
export function lanOrder(addrs = [], mine = getLanAddresses()) {
  const nets = new Set(mine.map(a => String(a).split('.').slice(0, 3).join('.')))
  const same = (a) => nets.has(String(a).split('.').slice(0, 3).join('.'))
  return [...new Set(addrs)].filter(lanUsable).sort((x, y) => Number(same(y)) - Number(same(x)))
}

export function isCgnat(ip) {
  const m = /^100\.(\d+)\./.exec(String(ip || ''))
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

/**
 * The addresses to put in a discovery reply: LAN ones only (192.168 / 10 /
 * 172.16-31 first), the one on the asker's /24 first. Never 100.64/10 or 169.254.
 */
export function advertisedAddresses(askerIp = '', all = getLanAddresses()) {
  const lan = all.filter((a) => !isCgnat(a) && !a.startsWith('169.254.'))
  const net24 = String(askerIp).split('.').slice(0, 3).join('.') + '.'
  const same = lan.filter((a) => askerIp && a.startsWith(net24))
  return [...same, ...lan.filter((a) => !same.includes(a))]
}

/** The single best address to advertise. `null` when fully offline. */
export function getPrimaryLanAddress() {
  return getLanAddresses()[0] || null
}

export function stopDiscoveryResponder() {
  if (responder) responder.close()
}

/**
 * Start answering discovery broadcasts.
 *
 * @param {{port?:number, name?:string, getInfo?:()=>object, logger?:object}} opts
 * @returns {{close:()=>void, port:number}|null}
 */
export function startDiscoveryResponder(opts = {}) {
  if (responder) return responder

  const port = Number(opts.port) || DISCOVERY_PORT
  const log = opts.logger || console
  let companyName = opts.name || 'Adal Keep'

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  sock.on('error', (err) => {
    // A busy port (another Adal Keep already answering) must never kill the
    // server — discovery is a convenience, not a dependency.
    log.warn?.(`[discovery] UDP socket error on ${port}: ${err.message}`)
    try { sock.close() } catch {}
    responder = null
  })

  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8').trim()
    if (text.startsWith('ADAL_KEEP_PC_V1')) { try { presenceHandler?.(text, rinfo) } catch {} ; return }
    if (text.startsWith('ADAL_KEEP_PEER')) {
      try {
        const answer = peerHandler?.(text, rinfo)
        if (answer) sock.send(Buffer.from(answer, 'utf8'), rinfo.port, rinfo.address, () => {})
      } catch {}
      return
    }
    if (!text.startsWith(DISCOVERY_REQUEST)) return
    // Only the PC holding the main PC's role answers "where is Adal Keep?" (a
    // Companion with its own copy answers its agency's PCs only, above).
    if (opts.answerServer && !opts.answerServer()) return
    try {
      const extra = (opts.getInfo && opts.getInfo()) || {}
      if (extra.company_name) companyName = extra.company_name
      const ips = advertisedAddresses(rinfo.address)
      const httpPort = Number(extra.port || process.env.PORT || 4000)
      const payload = [
        DISCOVERY_RESPONSE,
        String(httpPort),
        ips[0] || '', // empty: the Companion uses this reply's source address
        String(companyName || 'Adal Keep').replace(/\|/g, ' '),
        ips.join(','),
        macsOf(ips).join(','),
      ].join('|')
      sock.send(Buffer.from(payload, 'utf8'), rinfo.port, rinfo.address, () => {})
      log.info?.(`[discovery] answered ${rinfo.address} with ${payload}`)
    } catch (e) {
      log.warn?.(`[discovery] failed to answer ${rinfo.address}: ${e.message}`)
    }
  })

  try {
    sock.bind(port, () => {
      try { sock.setBroadcast(true) } catch {}
      log.info?.(`[discovery] listening for employees on UDP ${port}`)
    })
  } catch (e) {
    log.warn?.(`[discovery] cannot bind UDP ${port}: ${e.message}`)
    return null
  }

  responder = {
    port,
    sock,
    close() {
      try { sock.close() } catch {}
      responder = null
    },
  }
  return responder
}

/**
 * Client side of the protocol — used by tests and by the Server PC's own
 * tray app when it wants to confirm discovery is actually visible on the
 * LAN. Broadcasts the request and resolves with the first valid answer.
 *
 * @param {{timeoutMs?:number, port?:number}} opts
 * @returns {Promise<{url:string,host:string,port:number,name:string}|null>}
 */
export function discoverServer(opts = {}) {
  const port = Number(opts.port) || DISCOVERY_PORT
  const timeoutMs = Number(opts.timeoutMs) || 2500

  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { sock.close() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    sock.on('error', () => { clearTimeout(timer); finish(null) })
    sock.on('message', (msg, rinfo = {}) => {
      const parts = msg.toString('utf8').trim().split('|')
      if (parts[0] !== DISCOVERY_RESPONSE) return
      const httpPort = Number(parts[1]) || 4000
      const host = rinfo.address || parts[2]
      clearTimeout(timer)
      finish({
        url: `http://${host}:${httpPort}`,
        host,
        port: httpPort,
        name: parts[3] || 'Adal Keep',
        addresses: (parts[4] || parts[2] || '').split(',').filter(Boolean),
        macs: (parts[5] || '').split(',').filter(Boolean),
      })
    })

    sock.bind(() => {
      try { sock.setBroadcast(true) } catch {}
      const buf = Buffer.from(DISCOVERY_REQUEST, 'utf8')
      sock.send(buf, 0, buf.length, port, '255.255.255.255', () => {})
      // Some Windows/Linux stacks drop the limited broadcast; the subnet
      // broadcast is the reliable second shot.
      for (const ip of getLanAddresses()) {
        const bcast = ip.split('.').slice(0, 3).join('.') + '.255'
        try { sock.send(buf, 0, buf.length, port, bcast, () => {}) } catch {}
      }
    })
  })
}

export default {
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  DISCOVERY_RESPONSE,
  getLanAddresses,
  getPrimaryLanAddress,
  advertisedAddresses,
  macsOf,
  isCgnat,
  startDiscoveryResponder,
  stopDiscoveryResponder,
  discoverServer,
}
