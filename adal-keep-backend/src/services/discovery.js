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
 *   response -> "ADAL_KEEP_SERVER_V1|<port>|<lan-ip>|<name>"
 */

import dgram from 'dgram'
import os from 'os'

export const DISCOVERY_PORT = 45454
export const DISCOVERY_REQUEST = 'ADAL_KEEP_DISCOVER_V1'
export const DISCOVERY_RESPONSE = 'ADAL_KEEP_SERVER_V1'

let responder = null

/**
 * Every non-internal IPv4 address this machine can be reached on.
 * Sorted so that real LAN ranges (192.168.x.x / 10.x.x.x / 172.16-31.x.x)
 * come before virtual-adapter noise (WSL 172.17-31, VirtualBox 192.168.56,
 * Docker bridges). Windows machines routinely have five of these.
 * @returns {string[]}
 */
export function getLanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`
      if (family !== 'IPv4' || a.internal) continue
      if (!a.address || a.address.startsWith('169.254.')) continue // APIPA = no LAN
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
    return s
  }
  return out.sort((a, b) => score(b) - score(a)).map((x) => x.address)
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
    if (!text.startsWith(DISCOVERY_REQUEST)) return
    try {
      const extra = (opts.getInfo && opts.getInfo()) || {}
      if (extra.company_name) companyName = extra.company_name
      const lanIp = getPrimaryLanAddress()
      const httpPort = Number(extra.port || process.env.PORT || 4000)
      const payload = [
        DISCOVERY_RESPONSE,
        String(httpPort),
        lanIp || rinfo.address,
        String(companyName || 'Adal Keep').replace(/\|/g, ' '),
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
    sock.on('message', (msg) => {
      const parts = msg.toString('utf8').trim().split('|')
      if (parts[0] !== DISCOVERY_RESPONSE) return
      const httpPort = Number(parts[1]) || 4000
      const host = parts[2]
      clearTimeout(timer)
      finish({
        url: `http://${host}:${httpPort}`,
        host,
        port: httpPort,
        name: parts.slice(3).join('|') || 'Adal Keep',
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
  startDiscoveryResponder,
  stopDiscoveryResponder,
  discoverServer,
}
