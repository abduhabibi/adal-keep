/**
 * equal.js — "every PC equal" on a running PC (ADAL_EQUAL_PCS=1 or strict;
 * docs/equal-pcs.md). Off: nothing here runs and the PCs work as before.
 *
 *   attachTrust(node)   the certificate on both sides of the copying (trust.js),
 *                       the revoked list followed (from the cloud, from the PCs)
 *   equalRoutes(router) this PC's own pages:
 *     GET  /sync/trust            joined? the agency, the certificate, the list's number
 *     POST /sync/join-cloud       {code} → ask the cloud to join (a Yes comes from a PC or Admin)
 *     POST /sync/join-collect     the certificate, once approved; then the first copy from any PC
 *     GET  /sync/join-requests    PCs asking to join this agency now
 *     POST /sync/join-approve     {request_id} → this PC's Yes (signed with its device key)
 *     POST /sync/vouch            (from a PC of the agency, with its key — moving over)
 *                                 {request_id} → this PC says Yes for that very PC
 */
import os from 'os'
import { TrustStore, TrustClient, TrustServer, equalPCs, strictTrust, isRevoked, sign } from './trust.js'
import { CloudTrust, approveSig, collectSig, pendingSig, reserveSig } from './authority.js'
import { Roles } from './roles.js'

let store = null
export const trustStore = () => (store = store || new TrustStore())

/** The cloud's door (the Supabase function agency-trust), or ADAL_TRUST_CLOUD in tests. */
export async function cloud() {
  if (process.env.ADAL_TRUST_CLOUD) return new CloudTrust({ url: process.env.ADAL_TRUST_CLOUD })
  const { cloudConfig } = await import('../chatCloud.js')
  const { url, anon } = cloudConfig()
  if (!url) return null
  return new CloudTrust({ url: `${url}/functions/v1/agency-trust`, headers: { apikey: anon, authorization: `Bearer ${anon}` } })
}

/**
 * The node takes certificates (both ways) when this PC has one. A newer revoked
 * list: this PC itself on it → cut off; another PC on it → its row says removed
 * too (so its old key is refused as well, and that is copied to every PC).
 */
export function attachTrust(node, { st = trustStore(), log = console, f = fetch } = {}) {
  node.equal = true
  node.strict = strictTrust()
  if (!st.ready()) return null
  const onCRL = (crl) => applyCRL(node, st, crl).catch(e => log.warn?.(`[trust] list: ${e.message}`))
  node.trust = new TrustClient(st, { fetch: f, now: () => node.now(), onCRL })
  node.trustServer = new TrustServer(st, { now: () => node.now(), onCRL, log })
  if (st.revokedHere()) node.cutOff = 'removed'
  return node.trust
}
export async function applyCRL(node, st, crl = st.crl) {
  if (st.revokedHere()) { node.cutOff = 'removed'; node.trust?.forget(); return }
  node.trustServer?.cutRevoked()
  const pcs = await node.roles.pcs()
  for (const r of crl?.p?.revoked || []) {
    const row = pcs.find(p => p.pc_id === r.pc_id)
    if (row && !row.revoked_at && row.pc_id !== node.pcId) await node.setCut(row.pc_id, 'remove')
    node.trustServer?.cutPC(r.pc_id)
  }
  for (const [url, s] of node.trust?.sessions || []) if (isRevoked(crl, s.peer)) node.trust.forget(url)
}

/** Every 10 minutes when online: the newest revoked list from the cloud; this PC's power for the role. */
export function startTrustJobs(node, { st = trustStore(), every = 10 * 60 * 1000 } = {}) {
  const go = async () => {
    if (!st.ready()) return
    const c = await cloud().catch(() => null)
    if (!c) return
    const r = await c.op('crl', { agency_id: st.agencyId() }).catch(() => null)
    if (r?.crl && st.takeCRL(r.crl)) await applyCRL(node, st)
  }
  node.roles.publishPower(Roles.power()).catch(() => {})
  setTimeout(() => go().catch(() => {}), 15000).unref?.()
  const t = setInterval(() => go().catch(() => {}), every); t.unref?.()
  return t
}

// ── This PC's own pages ─────────────────────────────────────────────────────

export function equalRoutes(router, { getNode, here, keyOf, dbFile, restart = () => setTimeout(() => process.exit(0), 1200), st = trustStore, cloudOf = cloud }) {
  const local = (req, res, next) => (here(req) ? next() : res.status(403).json({ error: 'Only on this PC itself' }))
  const fail = (res, e) => res.status(e.status && e.status < 600 ? e.status : 400).json({ error: e.message })
  const off = (res) => { if (equalPCs()) return false; res.status(404).json({ error: 'Equal PCs are off on this PC' }); return true }

  router.get('/sync/trust', local, (req, res) => {
    if (off(res)) return
    const s = st()
    res.json({ ready: s.ready(), agency: s.agencyId(), pc_id: s.cert?.p?.pc_id || null, slot: s.cert?.p?.slot ?? null, serial: s.cert?.p?.serial || null, expires_at: s.cert?.p?.expires_at || null, crl_version: s.crl?.p?.version || 0, revoked_here: s.revokedHere(), request: s.read().request || null, strict: strictTrust(), refused: getNode()?.trustServer?.refused || 0 })
  })

  router.post('/sync/join-cloud', local, async (req, res) => {
    if (off(res)) return
    try {
      const { readIdentity } = await import('./identity.js')
      const id = readIdentity()
      const c = await cloudOf()
      if (!c) throw Object.assign(new Error('No internet link to Adal\'s cloud on this PC'), { status: 503 })
      const r = await c.op('request', { code: req.body?.code, pc_id: id.pc_id, device_pub: st().device.pub, name: os.hostname(), ...(id.joined_main || getNode() ? { slot: id.slot } : {}) })
      st().write({ request: { id: r.request_id, at: new Date().toISOString() } })
      // Moving over (this PC is in the agency already, with its key): a PC that has its
      // certificate says Yes for it at once — nobody needs to click.
      const node = getNode()
      let vouched = false
      for (const [, p] of node?.peerState || []) {
        if (!p.ok || !p.url || vouched) continue
        try { await node.call(p.url, 'POST', '/vouch', { request_id: r.request_id }, { timeout: 15000 }); vouched = true } catch {}
      }
      res.json({ ok: true, request_id: r.request_id, vouched })
    } catch (e) { fail(res, e) }
  })

  router.post('/sync/join-collect', local, async (req, res) => {
    if (off(res)) return
    try {
      const s = st(), rq = s.read().request
      if (!rq?.id) throw Object.assign(new Error('Ask to join first'), { status: 409 })
      const c = await cloudOf()
      const got = await c.op('collect', { request_id: rq.id, sig: collectSig(s.device.priv, rq.id) })
      if (got.waiting) return res.json({ waiting: true })
      const p = s.adopt(got)
      const { updateIdentity, readIdentity } = await import('./identity.js')
      updateIdentity({ slot: p.slot, agency_id: p.agency_id })
      // Already in the agency (moving over): nothing to copy, the certificate is used from the restart.
      if (readIdentity().joined_main || getNode()) { res.json({ ok: true, slot: p.slot, restart: true }); return restart() }
      // A new PC: its first copy from whichever PC of the agency answers on the network.
      const out = await firstCopy({ dbFile })
      res.json({ ok: true, slot: p.slot, from: out.from, restart: true })
      restart()
    } catch (e) { fail(res, e) }
  })

  router.get('/sync/join-requests', local, async (req, res) => {
    if (off(res)) return
    try {
      const s = st(), at = new Date().toISOString()
      const r = await (await cloudOf()).op('pending', { agency_id: s.agencyId(), cert: s.cert, at, sig: pendingSig(s.device.priv, s.agencyId(), at) })
      res.json(r)
    } catch (e) { fail(res, e) }
  })
  router.post('/sync/join-approve', local, async (req, res) => {
    if (off(res)) return
    try { res.json(await approve(String(req.body?.request_id || ''))) } catch (e) { fail(res, e) }
  })

  // Moving over: a PC of the agency (with its key, as before) asks this PC to say Yes for it.
  router.post('/sync/vouch', async (req, res) => {
    if (off(res)) return
    try {
      const node = getNode()
      const peer = node?.peerByKey(keyOf(req))
      if (!peer || req.headers['x-adal-cloud']) return res.status(401).json({ error: 'Not a PC of this agency' })
      const s = st(), at = new Date().toISOString()
      const { pending } = await (await cloudOf()).op('pending', { agency_id: s.agencyId(), cert: s.cert, at, sig: pendingSig(s.device.priv, s.agencyId(), at) })
      const r = pending.find(x => x.id === req.body?.request_id)
      // Only for that very PC (the key it called with is its own row's), with the slot it has.
      if (!r || r.pc_id !== peer.pc_id) return res.status(403).json({ error: 'That request is not this PC\'s' })
      res.json(await approve(r.id, r))
    } catch (e) { fail(res, e) }
  })

  async function approve(requestId, r = null) {
    const s = st(), c = await cloudOf(), at = new Date().toISOString()
    if (!r) r = (await c.op('pending', { agency_id: s.agencyId(), cert: s.cert, at, sig: pendingSig(s.device.priv, s.agencyId(), at) })).pending.find(x => x.id === requestId)
    if (!r) throw Object.assign(new Error('No such request'), { status: 404 })
    return c.op('approve', { request_id: r.id, anchor: s.anchor, cert: s.cert, sig: approveSig(s.device.priv, { request_id: r.id, pc_id: r.pc_id, device_pub: r.device_pub }) })
  }
}

/** The first PC moved over: the slots its agency's PCs already use stay theirs (sync_pcs → the cloud). */
export async function reserveSlots(node, { st = trustStore(), cloudOf = cloud } = {}) {
  const rows = (await node.roles.pcs()).filter(p => Number.isInteger(Number(p.slot))).map(p => ({ pc_id: p.pc_id, slot: Number(p.slot) }))
  return (await cloudOf()).op('reserve', { agency_id: st.agencyId(), rows, cert: st.cert, sig: reserveSig(st.device.priv, rows) })
}

/** A new PC: its database and keys from the first PC of the agency that answers (UDP, agency tag). */
export async function firstCopy({ dbFile, st = trustStore(), wait = 2500 }) {
  const { PeerFinder } = await import('./peers.js')
  const { joinFromPeer, stageJoin } = await import('./bootstrap.js')
  const disco = await import('../discovery.js')
  const client = new TrustClient(st)
  // (A finder with no list yet: it listens for the agency's tag only.)
  const fake = { trust: client, strict: true, pcId: st.cert.p.pc_id, port: Number(process.env.PORT) || 4000, name: os.hostname(), addresses: () => disco.getLanAddresses(), roles: { pcs: async () => [], licence: () => null } }
  const finder = new PeerFinder(fake, { port: Number(process.env.DISCOVERY_PORT) || disco.DISCOVERY_PORT })
  await finder.refresh()
  await finder.search({ wait })
  for (const [, f] of finder.found) for (const url of f.urls) {
    try {
      const got = await joinFromPeer({ url, call: (u, m, p, b, o) => client.call(u, m, p, b, o) })
      await stageJoin(got, { dbFile })
      return got
    } catch {}
  }
  throw Object.assign(new Error('No PC of the agency answered on this network — switch one on and try again'), { status: 503 })
}
export { sign }
