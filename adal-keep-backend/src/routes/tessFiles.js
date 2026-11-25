/**
 * /tess/* — the passport reader's own files (tesseract's worker, its engine and the OCR-B and
 * English models), served to another PC's window on the office network so that an Adal Companion
 * reads a passport itself (frontend lib/passportHere.js) instead of waiting for this PC, which may
 * be busy with robots. Four fixed files, read-only; the browser keeps them for a day.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILES = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'ocrb.traineddata': 'ocrb.traineddata',
  'eng.traineddata': 'eng.traineddata',
}
const router = express.Router()
router.get('/:name', (req, res) => {
  const rel = Object.hasOwn(FILES, req.params.name) ? FILES[req.params.name] : null
  const file = rel && path.join(ROOT, rel)
  if (!file || !fs.existsSync(file)) return res.status(404).end()
  res.set('Cache-Control', 'public, max-age=86400')
  res.type(/\.js$/.test(file) ? 'application/javascript' : 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})
export default router
