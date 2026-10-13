import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { createWorker } from 'tesseract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagePath = process.argv[2]
if (!imagePath || !fs.existsSync(imagePath)) {
  console.error('usage: node debug-passport.mjs /path/to/passport.jpg')
  process.exit(1)
}

const out = []
const log = (...a) => { const s = a.map(String).join(' '); out.push(s); console.log(s) }

log('=========================================================')
log('PASSPORT OCR DIAGNOSTIC')
log('=========================================================')
log('Image:  ' + imagePath)
log('Ran at: ' + new Date().toISOString())
log('')

const meta = await sharp(imagePath).metadata()
const w = meta.width, h = meta.height
log('Dimensions: ' + w + ' x ' + h)
log('')

const worker = await createWorker(['eng', 'amh'], 1, {
  langPath: __dirname,
  cachePath: path.join(__dirname, 'data/tessdata'),
  gzip: false,
  logger: () => {},
})

async function rec(p, psm, whitelist) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: whitelist || '',
  })
  const r = await worker.recognize(p)
  return r.data.text || ''
}

log('===== PASS A: WHOLE IMAGE | PSM 11 | eng+amh =====')
const textA = await rec(imagePath, 11)
log(textA || '(empty)')
log('')

log('===== PASS B: WHOLE IMAGE | PSM 6 | eng+amh =====')
const textB = await rec(imagePath, 6)
log(textB || '(empty)')
log('')

log('===== PASS C: TOP 88% CROP | PSM 11 | eng+amh =====')
const visPath = path.join(os.tmpdir(), 'dbg_vis_' + Date.now() + '.png')
await sharp(imagePath)
  .extract({ left: 0, top: 0, width: w, height: Math.floor(h * 0.88) })
  .resize({ width: Math.min(w * 2, 3000), kernel: 'lanczos3' })
  .toFile(visPath)
const textC = await rec(visPath, 11)
log(textC || '(empty)')
log('')

log('===== PASS D: TOP 96% CROP | PSM 11 | eng+amh =====')
const visPath96 = path.join(os.tmpdir(), 'dbg_vis96_' + Date.now() + '.png')
await sharp(imagePath)
  .extract({ left: 0, top: 0, width: w, height: Math.floor(h * 0.96) })
  .resize({ width: Math.min(w * 2, 3000), kernel: 'lanczos3' })
  .toFile(visPath96)
const textD = await rec(visPath96, 11)
log(textD || '(empty)')
log('')

log('===== PASS E: BOTTOM 15% CROP | PSM 6 | A-Z 0-9 < =====')
const mrzPath = path.join(os.tmpdir(), 'dbg_mrz_' + Date.now() + '.png')
await sharp(imagePath)
  .extract({ left: 0, top: Math.floor(h * 0.85), width: w, height: h - Math.floor(h * 0.85) })
  .resize({ width: w * 3, kernel: 'lanczos3' })
  .grayscale().normalize()
  .toFile(mrzPath)
const textE = await rec(mrzPath, 6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<')
log(textE || '(empty)')
log('')

log('===== LABEL FORENSICS (searched across PASS A/B/C/D) =====')
const allVisual = [textA, textB, textC, textD].join('\n---PASS---\n')
const needles = [
  'Date of Issue','Date of Expiry','Date of Birth',
  'Issue','Issued','Expiry','Expire','Birth','Issue ',
  'DEC','SEP','JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','OCT','NOV',
  'MURASA','ETHIOPIAN','DEB0CH','DEBOCH','MIHRET','19 DEC','18 DEC',
]
for (const n of needles) {
  const idx = allVisual.indexOf(n)
  if (idx === -1) log('  "' + n + '": NOT FOUND')
  else {
    const ctx = allVisual.slice(Math.max(0, idx - 40), idx + n.length + 60).replace(/\n/g, ' | ')
    log('  "' + n + '": ' + ctx)
  }
}
log('')

log('===== PASS C ESCAPED (first 400 chars) =====')
log(JSON.stringify(textC.slice(0, 400)))
log('')

try {
  const { parseTD3 } = await import('./src/services/mrz.js')
  log('===== MRZ PARSED =====')
  log(JSON.stringify(parseTD3(textE), null, 2))
} catch (e) {
  log('MRZ parser import failed: ' + e.message)
}

await worker.terminate()
for (const f of [visPath, visPath96, mrzPath]) { try { fs.unlinkSync(f) } catch {} }

const outPath = path.join(__dirname, 'PASSPORT-DEBUG.txt')
fs.writeFileSync(outPath, out.join('\n'))
console.log('')
console.log('✅ Written: ' + outPath)
