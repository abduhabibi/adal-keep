/**
 * The faithful Refine with a before / after (services/faithfulRefine.js). A person's click only.
 *   POST /photo-refine/:fileId/preview   { size: 'original' | '2k' | '4k', engine: 'plain' | 'esrgan' } → { token, width, height, bytes, from, scale }
 *   GET  /photo-refine/preview/:token    the refined JPEG (not saved yet)
 *   POST /photo-refine/preview/:token/keep   saves it as the newest file of the field; the original stays
 * One refine at a time (a queue: a second click waits its turn); the work is in sharp's own threads, the server stays free.
 * Off with ADAL_PHOTO_QUALITY=0 (then the page uses the old Refine).
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { refineFaithful, on } from '../services/faithfulRefine.js'
import { esrganOn, verifyModel } from '../services/esrganModel.js'

const router = express.Router()
const KEEP_MS = 10 * 60_000
const kept = new Map()   // token → { buf, fileId, at, from }
let line = Promise.resolve()
const inTurn = (fn) => { const run = line.then(fn); line = run.then(() => {}, () => {}); return run }
const sweep = () => { for (const [k, v] of kept) if (Date.now() - v.at > KEEP_MS) kept.delete(k) }

// esrgan: the AI way can be offered (its flag is on and the exact model file is in data/models).
router.get('/photo-refine/status', (req, res) => res.json({ faithful: on(), esrgan: esrganOn() && verifyModel().ok }))

router.post('/photo-refine/:fileId/preview', async (req, res) => {
  if (!on()) return res.status(404).json({ error: 'The new Refine is turned off on this PC.' })
  try {
    const db = req.app.locals.db
    const file = await db('files').where('id', req.params.fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })
    const field = await db('profile_fields').where('id', file.profile_field_id).first()
    const { REFINABLE } = await import('../services/photoRefine.js')
    if (!field || !REFINABLE.includes(field.name)) return res.status(400).json({ error: 'Only a Photo or Full Body Photo can be refined' })
    if (!String(file.mimetype || '').startsWith('image/')) return res.status(400).json({ error: 'That file is not a picture' })
    const { resolveStoredPath } = await import('../services/cvRender.js')
    const src = resolveStoredPath(file.path)
    if (!src || !fs.existsSync(src)) return res.status(404).json({ error: 'The picture is not on this PC' })
    const size = ['original', '2k', '4k'].includes(req.body?.size) ? req.body.size : 'original'
    const engine = req.body?.engine === 'esrgan' ? 'esrgan' : 'plain'
    const r = await inTurn(() => refineFaithful(fs.readFileSync(src), { size, engine, upscale: req.app.locals.srUpscale || null }))
    sweep()
    const token = crypto.randomBytes(12).toString('hex')
    kept.set(token, { buf: r.buf, fileId: file.id, at: Date.now(), name: file.original_name || field.name, fieldId: field.id })
    res.json({ token, width: r.width, height: r.height, bytes: r.buf.length, from: r.from, scale: r.scale, size, engine: r.engine, blend: r.blend, check: r.check, note: r.note })
  } catch (e) {
    console.error('[refine-preview]', e)
    res.status(500).json({ error: 'Refine failed: ' + e.message })
  }
})

router.get('/photo-refine/preview/:token', (req, res) => {
  const k = kept.get(req.params.token)
  if (!k) return res.status(404).json({ error: 'This preview is gone — refine again.' })
  res.set('Cache-Control', 'no-store').type('image/jpeg').send(k.buf)
})

router.post('/photo-refine/preview/:token/keep', async (req, res) => {
  const k = kept.get(req.params.token)
  if (!k) return res.status(404).json({ error: 'This preview is gone — refine again.' })
  try {
    const db = req.app.locals.db
    const { generateThumbnail } = await import('../services/storage.js')
    const dir = path.join(process.cwd(), 'data', 'SafeStorage')
    fs.mkdirSync(dir, { recursive: true })
    const stem = String(k.name).replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_').slice(0, 60)
    const stored = `${Date.now()}_${stem}-refined.jpg`
    const abs = path.join(dir, stored)
    fs.writeFileSync(abs, k.buf)
    try { await generateThumbnail(abs) } catch {}
    const now = new Date().toISOString()
    const [id] = await db('files').insert({ profile_field_id: k.fieldId, original_name: `${stem}-refined.jpg`, path: stored, mimetype: 'image/jpeg', size: k.buf.length, created_at: now, updated_at: now })
    kept.delete(req.params.token)
    res.json({ ok: true, file: await db('files').where('id', id).first() })
  } catch (e) {
    console.error('[refine-keep]', e)
    res.status(500).json({ error: 'Could not save: ' + e.message })
  }
})
export default router
