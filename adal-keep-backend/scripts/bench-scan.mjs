// Times a passport scan end to end on made-up pages (no real person, no network, no keys).
//   unshare -rn taskset -c 0,1 node scripts/bench-scan.mjs [runs=20] [--slow-main=ms]
// Variants of tests/fixtures/sample-passport.jpg: big photo, small picture, turned 180/90,
// blurred, noisy low-quality JPEG, low contrast. Prints p50 / p95 / worst of the runs.
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'tests', 'fixtures', 'sample-passport.jpg')
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[k]
const runs = Number(process.argv[2]) || 20
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanfx-'))
const noise = async (b, sigma) => sharp(b).composite([{ input: { create: { width: 8, height: 8, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } } }, tile: true, blend: 'overlay' }]).toBuffer()
const variants = {
  big: () => sharp(src).toBuffer(),
  small: () => sharp(src).resize({ width: 1100 }).jpeg({ quality: 80 }).toBuffer(),
  turned180: () => sharp(src).rotate(180).toBuffer(),
  turned90: () => sharp(src).rotate(90).resize({ width: 2400 }).toBuffer(),
  blurred: () => sharp(src).blur(2.2).toBuffer(),
  noisy: async () => sharp(await noise(await sharp(src).resize({ width: 2000 }).toBuffer(), 40)).jpeg({ quality: 35 }).toBuffer(),
  dull: () => sharp(src).resize({ width: 2400 }).linear(0.45, 90).jpeg({ quality: 60 }).toBuffer(),
}
const files = []
for (const [k, f] of Object.entries(variants)) { const p = path.join(dir, `${k}.jpg`); fs.writeFileSync(p, await f()); files.push([k, p]) }
const qm = await import('../src/services/quickMrz.js'); { const w0 = performance.now(); await qm.warmMrzReader(); console.log('warm', Math.round(performance.now() - w0)) }
const { scan } = await import('../src/services/passportScan.js').catch(() => ({ scan: null }))
const { analyzeWithMineru } = await import('../src/services/mineruClassifier.js')
const run = scan || ((f) => analyzeWithMineru(f, { placeLater: true }))
const times = [], by = {}
let wrong = 0
for (let i = 0; i < runs; i++) {
  const [k, f] = files[i % files.length]
  const t = performance.now()
  const r = await run(f).catch(() => null)
  const ms = Math.round(performance.now() - t)
  const ok = r?.fields?.passport_number === 'L898902C3'
  if (r && r.fields?.passport_number && !ok) wrong++
  times.push(ms); (by[k] ||= []).push(`${ms}${ok ? '' : r?.doc_type ? '?' : 'x'}`)
}
const q = (p) => [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)]
console.log(JSON.stringify({ runs, p50: q(0.5), p95: q(0.95), worst: Math.max(...times), wrong }))
console.log(Object.entries(by).map(([k, v]) => `${k}: ${v.join(' ')}`).join('\n'))
process.exit(0)
