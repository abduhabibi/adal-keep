// CV preview / PDF timings for docs/speed.md: made-up photos the size phones
// take (12 MP), the sample passport, a scratch "database" in memory.
//   node scripts/bench-cv.mjs [old]   (old: first `git show <ref>:adal-keep-backend/src/services/cvRender.js > src/services/_oldCvRender.js`)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const old = process.argv[2] === 'old'
const R = await import(old ? '../src/services/_oldCvRender.js' : '../src/services/cvRender.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-cvbench-'))
const person = (w, h, wall, floor) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<rect width="100%" height="62%" fill="${wall}"/><rect y="62%" width="100%" height="38%" fill="${floor}"/>
<ellipse cx="${w * 0.5}" cy="${h * 0.16}" rx="${w * 0.07}" ry="${h * 0.055}" fill="#6b4a3a"/>
<rect x="${w * 0.4}" y="${h * 0.21}" width="${w * 0.2}" height="${h * 0.42}" rx="40" fill="#22303f"/>
<rect x="${w * 0.42}" y="${h * 0.62}" width="${w * 0.06}" height="${h * 0.3}" fill="#1b2430"/>
<rect x="${w * 0.52}" y="${h * 0.62}" width="${w * 0.06}" height="${h * 0.3}" fill="#1b2430"/></svg>`)
const photo = path.join(dir, 'photo.jpg'), body = path.join(dir, 'body.jpg'), pass = path.join(here, '..', 'tests', 'fixtures', 'sample-passport.jpg')
await sharp(person(3000, 4000, '#dfe6ee', '#c9c2b5')).jpeg({ quality: 92 }).toFile(photo)
await sharp(person(4000, 3000, '#e8e2d6', '#9b8f7d')).jpeg({ quality: 92 }).toFile(body)
const files = { Photo: { id: 1, path: photo, mimetype: 'image/jpeg' }, 'Full Body Photo': { id: 2, path: body, mimetype: 'image/jpeg' }, Passport: { id: 3, path: pass, mimetype: 'image/jpeg' } }
function db(table) {
  let field = null
  const q = {
    join: () => q, select: () => q, orderBy: () => q,
    where: (k, v) => { if (k === 'profile_fields.profile_id' || typeof k === 'object') return q; if (k === 'id') return q; return q },
    andWhere: (k, v) => { if (k === 'profile_fields.name') field = v; return q },
    first: async () => (table === 'brokers' ? { contact1: '0911000000' } : null),
    then: (res, rej) => Promise.resolve(table === 'files' && files[field] ? [files[field]] : []).then(res, rej),
  }
  return q
}
const profile = { id: 7, full_name: 'ANNA MARIA ERIKSSON', first_name: 'ANNA', last_name: 'ERIKSSON', passport_number: 'L898902C3', date_of_birth: '1974-08-12', religion: 'Muslim', broker_id: 1 }
const template = { id: 1, name: 'Bench', include_passport: 1, html_content: `<html><head></head><body><div class="cv-page"><div class="cv-body">
<table><tr><td><img src="{{PHOTO_URL}}" style="width:40mm;height:50mm;object-fit:cover"></td><td>{{FULL_NAME}}<br>{{PASSPORT_NO}}<br>{{DOB}}<br>{{RELIGION}}</td>
<td><img src="{{FULL_BODY_PHOTO_URL}}" style="width:60mm;height:150mm;object-fit:cover"></td></tr></table></div></div></body></html>`, css_content: '' }
const t = () => performance.now()
const out = {}
const build = async (level) => { const d = await R.buildTemplateData(db, profile, template, {}, { level }); return { data: d, html: R.mergeTemplate(template.html_content, template.css_content, d) } }
let a = t(); let m = await build(0); out.preview_cold = Math.round(t() - a)
a = t(); m = await build(0); out.preview_again = Math.round(t() - a)
out.preview_kb = Math.round(m.html.length / 1024)
out.box = /data-adal-box="([^"]*)"/.exec(m.html)?.[1] || '-'
a = t(); await R.htmlToSmallPdf(build, path.join(dir, 'a.pdf')); out.pdf_cold = Math.round(t() - a)
a = t(); await R.htmlToSmallPdf(build, path.join(dir, 'b.pdf')); out.pdf_warm = Math.round(t() - a)
if (R.preparePdf) {
  await R.preparePdf(build)
  await new Promise(r => setTimeout(r, 3000))   // the person looks at the preview
  a = t(); await R.htmlToSmallPdf(build, path.join(dir, 'c.pdf')); out.pdf_after_prepare = Math.round(t() - a)
}
out.pdf_kb = Math.round(fs.statSync(path.join(dir, 'b.pdf')).size / 1024)
console.log(old ? 'old' : 'new', JSON.stringify(out))
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
