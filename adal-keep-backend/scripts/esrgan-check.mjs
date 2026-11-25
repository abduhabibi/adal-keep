// Run on a PC that has the Real-ESRGAN model (data/models/realesr-general-x4v3.onnx) — onnxruntime-node must be installed:
//   node scripts/esrgan-check.mjs [outDir] [--model path]
// A made-up portrait (no real person) goes in at 1280 px, JPEG q55 like a forwarded photo; 2K and 4K come out the plain way and the
// AI way. Prints the model check, time, the match with the input (dB, limit 34), the colour shift (limit 1.0), the blend that
// passed and why a lower one was used. Exit 0 when the AI way produced a result within the limits at both sizes.
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { portrait, degrade, psnr } from './refine-lab.mjs'

process.env.ADAL_REFINE_ESRGAN = '1'
const args = process.argv.slice(2)
const mi = args.indexOf('--model'); if (mi >= 0) { process.env.ADAL_SR_MODEL = args[mi + 1]; args.splice(mi, 2) }
const out = args[0] || ''
const { refineFaithful, LIMIT_DB, LIMIT_SHIFT } = await import('../src/services/faithfulRefine.js')
const { verifyModel, modelFile } = await import('../src/services/esrganModel.js')

const v = verifyModel()
console.log(`model ${modelFile()}: ${v.ok ? 'OK (size and sha256 match)' : 'NOT USABLE — ' + v.reason}`)
try { await import('onnxruntime-node'); console.log('onnxruntime-node: found') } catch (e) { console.log('onnxruntime-node (in package.json, run npm install): NOT FOUND —', e.message.split('\n')[0]) }
const truth = await portrait(1920), input = await degrade(truth, { long: 1280, q: 55 })
console.log(`input ${(await sharp(input).metadata()).width}x${(await sharp(input).metadata()).height}, ${Math.round(input.length / 1024)} KB; limits: >= ${LIMIT_DB} dB, colour shift <= ${LIMIT_SHIFT}`)
let allOk = v.ok
for (const size of ['2k', '4k']) {
  for (const engine of ['plain', 'esrgan']) {
    const t = performance.now(); const r = await refineFaithful(input, { size, engine }); const s = ((performance.now() - t) / 1000).toFixed(1)
    const vsTruth = await psnr(r.buf, truth, (await sharp(truth).metadata()).width, (await sharp(truth).metadata()).height)
    console.log(`${size} ${engine.padEnd(6)} -> ${r.engine}${r.engine === 'esrgan' ? ' ' + Math.round(r.blend * 100) + '%' : ''}  ${r.width}x${r.height}  ${s} s  ${Math.round(r.buf.length / 1024)} KB  vs-truth ${vsTruth.toFixed(2)} dB${r.check ? `  vs-input ${r.check.db} dB, colour ${r.check.shift}` : ''}${r.note ? '  note: ' + r.note : ''}`)
    if (engine === 'esrgan' && r.engine !== 'esrgan') allOk = false
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${size}-${engine}.jpg`), r.buf) }
  }
}
if (out) { fs.writeFileSync(path.join(out, 'input.jpg'), input); fs.writeFileSync(path.join(out, 'truth.png'), truth) }
console.log(allOk ? 'RESULT: the AI way works on this PC within the limits' : 'RESULT: the AI way did not produce a result within the limits here (see the notes above)')
process.exit(allOk ? 0 : 1)
