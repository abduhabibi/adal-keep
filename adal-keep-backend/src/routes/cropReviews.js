/**
 * Crops waiting for a person's OK (services/placement.js saveForReview):
 *   GET  /profiles/:id/crop-reviews      the ones waiting for her
 *   GET  /crop-reviews/:id/image/:kind   a cut-out (photo, fullbody, passport) or 'original'
 *   POST /crop-reviews/:id               { use: ['photo', …] } + a re-framed part as a file
 *                                        named after its kind: they go into her boxes
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { answerReview } from '../services/placement.js'
import { resolveStoredPath } from '../services/cvRender.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
const KINDS = ['photo', 'fullbody', 'passport']

router.get('/profiles/:id/crop-reviews', async (req, res) => {
  try {
    const db = req.app.locals.db
    const rows = await db('crop_reviews').where({ profile_id: Number(req.params.id), status: 'waiting' }).orderBy('id')
    res.json(rows.map(r => ({
      id: r.id, field_name: r.field_name, created_at: r.created_at,
      parts: JSON.parse(r.parts || '[]').map(({ kind, box }) => ({ kind, box })),
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/crop-reviews/:id/image/:kind', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await db('crop_reviews').where({ id: Number(req.params.id) }).first()
    if (!row) return res.status(404).end()
    let abs = null
    if (req.params.kind === 'original') {
      const f = row.file_id ? await db('files').where('id', row.file_id).first() : null
      abs = f ? resolveStoredPath(f.path) : null
    } else {
      abs = JSON.parse(row.parts || '[]').find(p => p.kind === req.params.kind)?.path || null
    }
    if (!abs || !fs.existsSync(abs)) return res.status(404).end()
    res.set('Cache-Control', 'no-store')
    res.sendFile(path.resolve(abs))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/crop-reviews/:id', upload.fields(KINDS.map(name => ({ name, maxCount: 1 }))), async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.id)
    const row = await db('crop_reviews').where({ id }).first()
    if (!row) return res.status(404).json({ error: 'Not found' })
    let use = req.body?.use
    if (typeof use === 'string') { try { use = JSON.parse(use) } catch { use = use.split(',') } }
    use = (Array.isArray(use) ? use : []).filter(k => KINDS.includes(k))
    const replaced = {}
    for (const k of KINDS) {
      const f = req.files?.[k]?.[0]
      if (!f || !row.dir || !fs.existsSync(row.dir)) continue
      const to = path.join(row.dir, `${k}-framed.jpg`)
      const sharp = (await import('sharp')).default
      await sharp(f.buffer).rotate().jpeg({ quality: 92 }).toFile(to)
      replaced[k] = to
    }
    res.json(await answerReview(db, id, { use, replaced }))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
