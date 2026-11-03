/**
 * /api/embassy — what the Profiles page's selection bar prints for the embassy.
 *   GET /embassy/print?ids=1,2,3   per girl: her data, her photo, and two pages
 *                                  as pictures — the contract's first page and
 *                                  the visa payment page (when kept).
 * The page itself (3 pages a girl: contract · payment · our form with the visa
 * and application numbers as barcodes) is drawn by the frontend (/print/embassy).
 */
import express from 'express'
import fs from 'fs'
import { resolveStoredPath } from '../services/cvRender.js'

const router = express.Router()

// The fields a page can come from, best first.
const CONTRACT = [/^Contract$/i, /^Contract\b/i]
const PAYMENT = [/visa payment/i, /enjaz/i, /visa application/i, /^Visa$/i]
const PHOTO = [/^Photo$/i]

async function filesOf(db, id) {
  return db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', id)
    .select('profile_fields.name', 'files.path', 'files.mimetype', 'files.id').orderBy('files.id', 'desc')
}

const pick = (files, patterns) => {
  for (const re of patterns) {
    const f = files.find(x => re.test(x.name) && /pdf|image/i.test(x.mimetype || ''))
    if (f) return f
  }
  return null
}

/** A file as a picture: an image as it is; a PDF's first page rendered (2×). */
async function asPicture(f) {
  const abs = f && resolveStoredPath(f.path)
  if (!abs || !fs.existsSync(abs)) return null
  const buf = fs.readFileSync(abs)
  if (/image/i.test(f.mimetype || '')) return `data:${f.mimetype};base64,${buf.toString('base64')}`
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(buf, 'application/pdf')
  if (!doc.countPages()) return null
  const png = Buffer.from(doc.loadPage(0).toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true).asPNG())
  return `data:image/png;base64,${png.toString('base64')}`
}

router.get('/embassy/print', async (req, res) => {
  try {
    const db = req.app.locals.db
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 60)
    const email = (await db('settings').where('key', 'agency_email').first().catch(() => null))?.value || ''
    const out = []
    for (const id of ids) {
      const p = await db('profiles').where('id', id).first()
      if (!p) continue
      const files = await filesOf(db, id)
      const contract = pick(files, CONTRACT), payment = pick(files, PAYMENT), photo = pick(files, PHOTO)
      out.push({
        profile: p,
        contract_page: await asPicture(contract).catch(() => null),
        contract_from: contract?.name || null,
        payment_page: await asPicture(payment).catch(() => null),
        payment_from: payment?.name || null,
        photo: await asPicture(photo).catch(() => null),
      })
    }
    res.json({ agency_email: email, girls: out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
