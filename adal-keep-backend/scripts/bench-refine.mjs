// Compares the plain refine methods on made-up portraits (no real person, no network, no AI model):
//   node scripts/bench-refine.mjs [outDir]
// Truth = the portrait at 1920 px; the input = it shrunk to 960 px and JPEG q42 (what a forwarded WhatsApp photo
// looks like). Each method enlarges the input back to 1920. Measures: PSNR against the truth, PSNR of the result
// shrunk back to the input's size against the input ("faithful": it must still be the same picture), the mean
// colour shift (appearance) and fine-detail energy.
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { portrait, degrade, psnr, meanRGB, detail } from './refine-lab.mjs'
import { refineFaithful, PARAMS } from '../src/services/faithfulRefine.js'
import { finish } from '../src/services/refineCore.js'

const out = process.argv[2] || ''
const truth = await portrait(1920)
const input = await degrade(truth)
const W = (await sharp(truth).metadata()).width, H = (await sharp(truth).metadata()).height
const iw = (await sharp(input).metadata()).width, ih = (await sharp(input).metadata()).height
const methods = {
  'plain lanczos': async () => sharp(input).resize({ width: W, height: H, kernel: 'lanczos3', fit: 'fill' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer(),
  'lanczos + sharpen': async () => (await refineFaithful(input, { size: '2k', params: { chromaSigma: 0 } })).buf,
  'colour soften + lanczos': async () => (await refineFaithful(input, { size: '2k', params: { sharpAmount: 0 } })).buf,
  'faithful (default)': async () => (await refineFaithful(input, { size: '2k' })).buf,
  'faithful, stronger sharpen': async () => (await refineFaithful(input, { size: '2k', params: { sharpAmount: 1.1 } })).buf,
  'old finish() (light, colour, gamma, 4K)': async () => sharp(await finish(input)).resize({ width: W, height: H, fit: 'fill' }).jpeg({ quality: 95 }).toBuffer(),
}
const tMean = await meanRGB(truth), tDet = await detail(truth, W)
console.log(`truth ${W}x${H}; input ${iw}x${ih} ${Math.round(input.length / 1024)} KB; input detail ${(await detail(input, iw)).toFixed(2)} vs truth ${tDet.toFixed(2)}`)
console.log('method'.padEnd(42), 'PSNR vs truth', 'faithful(dB)', 'colour shift', 'detail', 'ms')
for (const [name, f] of Object.entries(methods)) {
  const t = performance.now(); const b = await f(); const ms = Math.round(performance.now() - t)
  const m = await meanRGB(b), shift = Math.max(...m.map((v, i) => Math.abs(v - tMean[i])))
  console.log(name.padEnd(42), (await psnr(b, truth, W, H)).toFixed(2).padStart(13), (await psnr(await sharp(b).resize({ width: iw, height: ih, fit: 'fill' }).png().toBuffer(), input, iw, ih)).toFixed(2).padStart(12), shift.toFixed(2).padStart(12), (await detail(b, W)).toFixed(2).padStart(6), String(ms).padStart(5))
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name.replace(/\W+/g, '_') + '.jpg'), b) }
}
if (out) { fs.writeFileSync(path.join(out, 'truth.png'), truth); fs.writeFileSync(path.join(out, 'input.jpg'), input) }
process.exit(0)
