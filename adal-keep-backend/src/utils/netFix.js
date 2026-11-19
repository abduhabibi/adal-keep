/**
 * netFix.js — names (api.telegram.org, the Supabase host) always resolve.
 *
 * Some office routers answer DNS badly: the reply carries its EDNS record in
 * the wrong section (dig: "malformed message packet"), the router refuses DNS
 * over TCP, and Windows then gives up on the name → ENOTFOUND / "fetch
 * failed", although a browser or Test-NetConnection (other resolver paths,
 * other caches) still gets through. So every lookup of this process:
 *   1. asks the PC's own resolver, IPv4 first, for at most 5 seconds;
 *   2. failing that, asks public DNS directly (Cloudflare, Google, Quad9);
 *   3. failing that too, uses the last good answer for that name (1 day).
 * Loaded first (main.js), it covers fetch, http(s) and every library.
 */
import dns from 'dns'

const PUBLIC = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4']
const SYSTEM_MS = 5000
const STALE_MS = 24 * 3600 * 1000

const system = dns.lookup
const remembered = new Map()   // host → { list: [{address, family}], at }
let resolver = null
function publicResolver() {
  if (!resolver) {
    resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 })
    resolver.setServers(PUBLIC)
  }
  return resolver
}

const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(':')
const familyOf = (o) => (typeof o === 'number' ? o : Number(o?.family) || 0)

function systemLookup(host, opts) {
  return new Promise((ok, no) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; no(Object.assign(new Error(`DNS timeout for ${host}`), { code: 'ETIMEOUT' })) } }, SYSTEM_MS)
    system.call(dns, host, { ...opts, all: true }, (err, list) => {
      if (done) return
      done = true; clearTimeout(t)
      if (err || !list?.length) no(err || Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))
      else ok(list)
    })
  })
}

async function publicLookup(host, family) {
  const r = publicResolver()
  const out = []
  if (family !== 6) { try { for (const a of await r.resolve4(host)) out.push({ address: a, family: 4 }) } catch {} }
  if (family !== 4 && (!out.length || family === 6)) { try { for (const a of await r.resolve6(host)) out.push({ address: a, family: 6 }) } catch {} }
  return out
}

/** The addresses of `host`: [{ address, family }], IPv4 first. Exported for tests. */
export async function resolveHost(host, opts = {}, { sys = systemLookup, pub = publicLookup } = {}) {
  const family = familyOf(opts)
  let list = null, firstErr = null
  try { list = await sys(host, opts) } catch (e) { firstErr = e }
  if (!list?.length) {
    list = await pub(host, family).catch(() => [])
    if (list.length && !warned.has(host)) { warned.add(host); console.warn(`[net] this PC's DNS could not find ${host} (${firstErr?.code || firstErr?.message}) — asked public DNS instead`) }
  }
  if (!list?.length) {
    const old = remembered.get(host)
    if (old && Date.now() - old.at < STALE_MS) return old.list
    throw firstErr || Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host })
  }
  list = [...list].sort((a, b) => a.family - b.family)   // IPv4 first: some lines have a broken IPv6 route
  remembered.set(host, { list, at: Date.now() })
  return list
}
const warned = new Set()

function lookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  if (typeof opts === 'number') opts = { family: opts }
  opts ||= {}
  if (!host || isIp(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return system.call(dns, host, opts, cb)
  resolveHost(host, opts).then(list => {
    const fam = familyOf(opts)
    const pick = fam ? list.filter(a => a.family === fam) : list
    if (!pick.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }))
    if (opts.all) cb(null, pick)
    else cb(null, pick[0].address, pick[0].family)
  }, err => cb(err))
}

let installed = false
export function installNetFix() {
  if (installed) return
  installed = true
  try { dns.setDefaultResultOrder('ipv4first') } catch {}
  dns.lookup = lookup
}

installNetFix()
