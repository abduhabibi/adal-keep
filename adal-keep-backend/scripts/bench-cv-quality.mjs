// A CV's pictures and PDF, before (the old levels, 300 KB rule) and after (full quality), on made-up pictures only:
//   node scripts/bench-cv-quality.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { portrait, degrade } from './refine-lab.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvq-'))
const big = await portrait(3000)                                   // a phone photo of her, 2250x3000
const photo = path.join(dir, 'photo.jpg'), body = path.join(dir, 'body.jpg'), pass = path.join(dir, 'pass.jpg'), ban = path.join(dir, 'banner.png')
fs.writeFileSync(photo, await degrade(big, { long: 1280, q: 55 }))   // what WhatsApp left of it
fs.writeFileSync(body, await sharp(big).jpeg({ quality: 88 }).toBuffer())
fs.writeFileSync(pass, await sharp(await portrait(2600)).resize({ width: 2600, height: 1830, fit: 'cover' }).jpeg({ quality: 90 }).toBuffer())
fs.writeFileSync(ban, await sharp({ create: { width: 1600, height: 220, channels: 4, background: '#1f6f5c' } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="220"><text x="60" y="140" font-size="90" fill="#fff" font-family="Liberation Sans">ADAL TEST AGENCY</text></svg>`), top: 0, left: 0 }]).png().toBuffer())

const run = async (label, env) => {
  process.env.ADAL_PHOTO_QUALITY = env
  const { _imageDataUri: img, htmlToPdf, buildTemplateData } = await import('../src/services/cvRender.js?' + label)
  void buildTemplateData
  const L = env === '0' ? { scale: 0.8, q: 70, palette: true } : { scale: 2, q: 95, palette: false }
  const px = (n) => Math.round(n * L.scale), pic = { quality: L.q, palette: L.palette }
  const t0 = performance.now()
  const [a, b, c, d] = await Promise.all([img(photo, 'image/jpeg', px(600), pic), img(body, 'image/jpeg', px(1000), pic), img(pass, 'image/jpeg', px(1300), pic), img(ban, null, px(1600), pic)])
  const tImg = performance.now() - t0
  const html = `<html><body style="margin:0;width:210mm"><img src="${d}" style="width:210mm;display:block"><div style="display:flex;gap:6mm;padding:8mm"><img src="${a}" style="width:50mm"><img src="${b}" style="width:60mm"></div><img src="${c}" style="width:190mm;margin:0 10mm"></body></html>`
  const out = path.join(dir, `${label}.pdf`)
  const t1 = performance.now()
  await htmlToPdf(html, out)
  return { label, images_ms: Math.round(tImg), pdf_ms: Math.round(performance.now() - t1), data_uri_kb: [a, b, c, d].map(x => Math.round(x.length * 0.75 / 1024)), pdf_kb: Math.round(fs.statSync(out).size / 1024), pdf: out }
}
const before = await run('before', '0'), after = await run('after', '1')
console.log(JSON.stringify({ stored_kb: { photo: Math.round(fs.statSync(photo).size / 1024), body: Math.round(fs.statSync(body).size / 1024), passport: Math.round(fs.statSync(pass).size / 1024) }, before, after }, null, 1))
process.exit(0)
