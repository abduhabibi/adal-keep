/**
 * A Companion's own photos and documents (services/docFeed.js, adal-companion owndocs.go).
 *
 *   GET  /companion/docs?at=&wait=   what changed since (it waits up to `wait` seconds for the next change)
 *   POST /companion/docs/check       { have: [[name, version] …] } → the names that differ now
 *   GET  /companion/docs/file/:id/(download|thumbnail)   one of them, by the program itself
 *   GET  /files/:id/(download|thumbnail) asked by a Companion's program for its window (x-adal-own): the
 *        answer is as ever, with what the file is (its name, version, SHA-256) beside it. x-adal-own: describe: that only, the
 *        file itself not (a 304). x-adal-seen: the
 *        window opened it from its own disk — nothing is sent, the audit line is written as ever.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import * as F from '../services/docFeed.js'

const router = express.Router()
const companionOnly = (req, res, next) => (req.pcAccess && !req.headers['x-adal-cloud'] && F.docsOn() ? next() : res.status(req.pcAccess ? 404 : 403).json({ error: 'Only an approved Adal Companion, on the office network' }))
const edge = (fn) => async (req, res, next) => { try { await fn(req, res, next) } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }) } }

router.get('/companion/docs', companionOnly, edge(async (req, res) => {
  F.startDocFeed(req.app.locals.db)
  const ac = new AbortController()
  res.on('close', () => ac.abort())
  const r = await F.next(req.app.locals.db, req.query.at, Math.min(55, Math.max(0, Number(req.query.wait) || 0)) * 1000, ac.signal)
  if (!res.writableEnded && !res.destroyed) res.set('Cache-Control', 'no-store').json(r)
}))
router.post('/companion/docs/check', companionOnly, edge(async (req, res) => {
  const have = Array.isArray(req.body?.have) ? req.body.have.filter(x => Array.isArray(x) && typeof x[0] === 'string') : []
  res.json({ differ: await F.differ(have), at: F.at() })
}))
// (a program fetching one for its disk is not a person opening it: past the audit list, services/audit.js)
router.get('/companion/docs/file/:id/:what(download|thumbnail)', companionOnly, (req, res, next) => {
  if (req.headers['x-adal-own'] !== 'describe') req.headers['x-adal-own'] = '1'
  delete req.headers['x-adal-seen']
  req.url = `/files/${encodeURIComponent(req.params.id)}/${req.params.what}`
  next()
})
router.get('/files/:id/:what(download|thumbnail)', (req, res, next) => {
  if (!req.headers['x-adal-own'] || !req.pcAccess || !F.docsOn()) return next()
  if (req.headers['x-adal-seen']) return res.status(204).end()
  const send = res.sendFile
  res.sendFile = function (file, ...a) {
    (async () => {
      try {
        const row = await req.app.locals.db('files').where('id', req.params.id).first('path')
        const st = fs.statSync(file)
        // (a thumbnail: the picture's own version too — a new picture makes a new thumbnail)
        const orig = !row?.path ? null : /^([a-zA-Z]:|\/)/.test(row.path) ? F.nameOf(row.path) : /^uploads\//.test(row.path.replace(/\\/g, '/')) ? row.path.replace(/\\/g, '/') : row.path.split(/[\\/]/).pop()
        // (the whole picture, while its small one is being made, is not its thumbnail)
        if (orig && !(req.params.what === 'thumbnail' && st.size > 60 * 1024)) {
          const { safe, uploads } = F.dirs()
          const of = orig.startsWith('uploads/') ? `${uploads}/${orig.slice(8)}` : `${safe}/${orig}`
          res.set('X-Adal-Doc', Buffer.from(JSON.stringify({ id: String(req.params.id), name: orig, v: F.versionOf(orig, fs.statSync(of)), sha: await F.hashOf(file, st), size: st.size })).toString('base64'))
        }
      } catch {}
      if (req.headers['x-adal-own'] === 'describe') {   // what it is, not the file: the Companion may have it in its copy
        res.type(path.extname(file)).set('Cache-Control', 'private, no-cache')
        if (a[0]?.headers) res.set(a[0].headers)
        return res.status(304).end()                      // (not opened yet: no audit line)
      }
      send.call(res, file, ...a)
    })()
    return res
  }
  next()
})
export default router
