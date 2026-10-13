import dotenv from "dotenv"; dotenv.config();
import fs from 'fs'
import path from 'path'
import { analyzeDocument } from './src/services/deepseekVision.js'

const img = process.argv[2]
if (!img || !fs.existsSync(img)) {
  console.error('usage: node test-vision.mjs /path/to/passport.jpg')
  process.exit(1)
}

const ext = path.extname(img).toLowerCase()
let imagePath = img
let mime = ext === '.png' ? 'image/png' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg'

// If PDF, render first page
if (ext === '.pdf') {
  const mupdf = await import('mupdf')
  const data = fs.readFileSync(img)
  const doc = mupdf.Document.openDocument(data, 'application/pdf')
  const page = doc.loadPage(0)
  const pix = page.toPixmap([3,0,0,3,0,0], mupdf.ColorSpace.DeviceRGB, false, true)
  imagePath = path.join('/tmp', `vision-test-${Date.now()}.png`)
  fs.writeFileSync(imagePath, Buffer.from(pix.asPNG()))
  mime = 'image/png'
}

console.log(`Sending ${img} (${mime}) to DeepSeek vision...\n`)

try {
  const result = await analyzeDocument(imagePath, path.basename(img), mime)
  console.log('===== VISION RESULT =====')
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error('ERROR:', e.message)
  console.error('\nIf the error mentions "model not found", try:')
  console.error('  AI_VISION_MODEL=deepseek-v4-flash-vision-exp node test-vision.mjs <image>')
}

if (ext === '.pdf') try { fs.unlinkSync(imagePath) } catch {}
