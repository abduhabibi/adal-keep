/**
 * /api/sync — the agency's PCs keep one set of data (services/sync/*).
 *
 * From another PC of the agency (its key, x-adal-pc, is in sync_pcs; never
 * through the online link; not suspended or removed):
 *   GET  /sync/hello          who this PC is, its role, what it has (vector)
 *   POST /sync/pull           {vector, limit} → the entries after it
 *   POST /sync/push           {entries, complete} → kept; this PC's vector
 *   GET  /sync/docs[?h=]      the documents here (name, size, sha256)
 *   GET  /sync/doc/:name      one document
 * From a computer let in with this PC's number (req.pcAccess), main PC only:
 *   POST /sync/join           {pc_id, name, lan, port} → its slot, its key on the list
 * On this PC only:
 *   GET  /sync/status         rounds, peers, the log, conflicts
 *   POST /sync/now            a round now
 *   POST /sync/take-main      {force} → this PC takes the main PC's role (restarts)
 *   POST /sync/hand-main      {pc_id} → the main PC gives its role to another PC (restarts)
 *   GET  /sync/conflicts      merges and documents kept beside
 */
import express from 'express'
import { withSlot } from '../services/replicaThrottle.js'

/** How far apart two PCs are: entries this PC has that the other has not (they_lack), and the other way. */
export function compareVectors(mine = {}, theirs = {}) {
  let they = 0, we = 0
  for (const o of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = Number(mine[o]) || 0, b = Number(theirs[o]) || 0
    if (a > b) they += a - b
    else if (b > a) we += b - a
  }
  return { they_lack: they, we_lack: we }
}

export function createSyncRouter({ getNode, here, admitted = (req) => req.pcAccess || null, keyOf = (req) => String(req.headers['x-adal-pc'] || ''), onJoined = null, onRole = null }) {
  const router = express.Router()
  const fail = (res, e) => res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message, ...(e.suspended ? { suspended: true } : {}) })
  const need = (res) => { const n = getNode(); if (!n) { res.status(503).json({ error: 'The copying is not running on this PC yet' }); return null } return n }

  const agencyPC = (req, res, next) => {
    const node = need(res)
    if (!node) return
    if (req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Not through the online link' })
    if (node.cutOff) return res.status(403).json({ error: `This PC was ${node.cutOff} by the main PC` })
    const key = keyOf(req)
    const p = node.peerByKey(key)
    if (p) {
      req.syncPeer = p
      // A PC this one could not reach (it was restarting, its address changed): it is there — a round with it now.
      if (!node.peerState.get(p.pc_id)?.ok) node.roundSoon?.(1000)
      return next()
    }
    const st = node.peerKeyState(key)
    if (st === 'suspended') return res.status(403).json({ error: 'This computer was suspended by the main PC', suspended: true })
    if (st === 'removed') return res.status(403).json({ error: 'This computer was removed from the agency' })
    return res.status(401).json({ error: 'Not a PC of this agency', pc_access: true })
  }
  const local = (req, res, next) => (here(req) ? next() : res.status(403).json({ error: 'Only on this PC itself' }))

  router.get('/sync/hello', agencyPC, async (req, res) => { try { res.json(await getNode().hello()) } catch (e) { fail(res, e) } })
  router.post('/sync/pull', agencyPC, async (req, res) => {
    // Paced like the replica copy (replicaThrottle): one transfer at a time, waiting while this PC is busy.
    try { res.json(await withSlot(() => getNode().engine.changesSince(req.body?.vector || {}, req.body?.limit))) } catch (e) { if (e.retryAfter) res.set('Retry-After', String(e.retryAfter)); fail(res, e) }
  })
  router.post('/sync/push', agencyPC, async (req, res) => {
    try {
      const node = getNode()
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : []
      if (entries.length > 20000) return res.status(413).json({ error: 'Too many at once' })
      const r = await node.engine.apply(entries, req.body?.complete || {})
      res.json({ ...r, vector: await node.engine.vector() })
    } catch (e) { fail(res, e) }
  })
  router.get('/sync/docs', agencyPC, async (req, res) => {
    try {
      const node = getNode()
      await node.docs.index({ budgetMs: 1500 })   // (new documents counted first; the rest by the next call)
      const list = await node.docs.list()
      if (req.query.h && req.query.h === list.hash) return res.json({ hash: list.hash, same: true })
      res.json(list)
    } catch (e) { fail(res, e) }
  })
  router.get('/sync/doc/:name', agencyPC, (req, res) => {
    try {
      const node = getNode()
      const name = String(req.params.name)
      if (!node.docs.has(name)) return res.status(404).json({ error: 'No such document' })
      res.set('Cache-Control', 'no-store')
      // One document at a time on this PC, after the robots and people (replicaThrottle).
      withSlot(() => new Promise(resolve => res.sendFile(node.docs.pathOf(name), { dotfiles: 'deny' }, () => resolve())))
        .catch(e => { if (res.headersSent) return; if (e.retryAfter) res.set('Retry-After', String(e.retryAfter)); fail(res, e) })
    } catch (e) { fail(res, e) }
  })

  router.post('/sync/join', async (req, res) => {
    const node = need(res)
    if (!node) return
    const pc = admitted(req)
    if (!pc || req.headers['x-adal-cloud']) return res.status(401).json({ error: "Come in with the main PC's number first", pc_access: true })
    try {
      const b = req.body || {}
      const r = await node.admit({ pc_id: String(b.pc_id || ''), name: b.name || pc.name, key: keyOf(req), access_id: pc.id || null, lan: b.lan, port: b.port })
      if (onJoined) await onJoined(r, req)
      res.json(r)
    } catch (e) { fail(res, e) }
  })

  router.get('/sync/status', local, async (req, res) => {
    try {
      const node = getNode()
      if (!node) return res.json({ running: false })
      const lease = await node.roles.leaseOf()
      const mine = await node.engine.vector()
      res.json({
        running: true, me: node.pcId, name: node.name, main: node.roles.isMain(), lease, cut_off: node.cutOff || null,
        status: node.status, engine: await node.engine.stats(),
        pcs: (await node.roles.pcs()).map(({ key_hash, vector, ...p }) => {
          const st = node.peerState.get(p.pc_id) || null
          const { vector: seenVec, ...reach } = st || {}
          const ip = (st?.url && /^https?:\/\/\[?([^\]/]+?)\]?:\d+/.exec(st.url)?.[1]) || p.lan?.[0] || null
          if (p.pc_id === node.pcId) return { ...p, ip, reach: null, me: true }
          const theirs = seenVec || vector || {}
          const gap = compareVectors(mine, theirs)
          const heard = node.finder?.found.get(p.pc_id)
          return { ...p, ip, reach: st ? reach : null, heard_at: heard?.at || null, ...gap, in_sync: !gap.they_lack && !gap.we_lack, vector_at: seenVec ? (st.seen || st.at) : p.seen_at }
        }),
        licence: node.roles.licence(),
        ignored: node.finder?.ignored || 0,
      })
    } catch (e) { fail(res, e) }
  })
  router.post('/sync/now', local, async (req, res) => { try { res.json(await need(res)?.round()) } catch (e) { fail(res, e) } })
  router.get('/sync/conflicts', local, async (req, res) => {
    try { res.json(await getNode().engine.db.raw(`SELECT id, at, tbl, rid, other, kind FROM sync_conflicts ORDER BY id DESC LIMIT 200`)) } catch (e) { fail(res, e) }
  })
  router.post('/sync/take-main', local, async (req, res) => {
    try {
      const r = await getNode().roles.take({ force: req.body?.force === true, by: String(req.body?.by || '') })
      res.json({ ...r, restart: !r.already })
      if (!r.already && onRole) onRole('main')
    } catch (e) { fail(res, e) }
  })
  router.post('/sync/hand-main', local, async (req, res) => {
    try {
      const r = await getNode().roles.handTo(String(req.body?.pc_id || ''), { by: String(req.body?.by || '') })
      await getNode().round().catch(() => {})   // the other PC hears it now, if it is on the network
      res.json({ ...r, restart: true })
      if (onRole) onRole('companion')
    } catch (e) { fail(res, e) }
  })
  return router
}
