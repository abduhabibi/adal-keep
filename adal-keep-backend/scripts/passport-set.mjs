// A made-up test set for "is this file a passport?": passports (the ICAO specimen page in the ways phones photograph it) and
// things that are not (blank, a portrait, a text page, a form with a table, MRZ-like lines with a wrong check digit, a tiny icon).
// No real person or agency file. makeSet(dir) → [{ name, file, yes }]
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import imageToPdf from 'image-to-pdf'
import { fileURLToPath } from 'url'
import { portrait } from './refine-lab.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(here, '..', 'tests', 'fixtures', 'sample-passport.jpg')
const text = (lines, W = 1240, H = 1754) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/><g font-family="Liberation Sans, Arial" font-size="28" fill="#222">${lines.map((l, i) => `<text x="80" y="${120 + i * 44}">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('')}</g></svg>`)
const L1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'
const L2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'

export async function makeSet(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const out = []
  const add = async (name, buf, yes, ext = 'jpg') => { const f = path.join(dir, `${name}.${ext}`); fs.writeFileSync(f, buf); out.push({ name: `${name}.${ext}`, file: f, yes }) }
  const noise = (b, sigma) => sharp(b).composite([{ input: { create: { width: 8, height: 8, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } } }, tile: true, blend: 'overlay' }]).toBuffer()
  // passports
  await add('passport-big', fs.readFileSync(SAMPLE), true)
  await add('passport-small', await sharp(SAMPLE).resize({ width: 1100 }).jpeg({ quality: 80 }).toBuffer(), true)
  await add('passport-180', await sharp(SAMPLE).rotate(180).resize({ width: 2000 }).jpeg().toBuffer(), true)
  await add('passport-90', await sharp(SAMPLE).rotate(90).resize({ width: 2400 }).jpeg().toBuffer(), true)
  await add('passport-blurred', await sharp(SAMPLE).blur(2.2).jpeg().toBuffer(), true)
  await add('passport-noisy', await sharp(await noise(await sharp(SAMPLE).resize({ width: 2000 }).toBuffer(), 40)).jpeg({ quality: 35 }).toBuffer(), true)
  await add('passport-dull', await sharp(SAMPLE).resize({ width: 2400 }).linear(0.45, 90).jpeg({ quality: 60 }).toBuffer(), true)
  await add('passport-poor', await sharp(SAMPLE).resize({ width: 1500 }).blur(2.8).jpeg({ quality: 18 }).toBuffer(), true)
  await add('passport-tilt', await sharp(SAMPLE).rotate(4, { background: '#bbb' }).resize({ width: 2400 }).jpeg({ quality: 70 }).toBuffer(), true)
  const pdf = path.join(dir, 'passport-scan.pdf')
  const tmpjpg = path.join(dir, '_p.jpg'); fs.writeFileSync(tmpjpg, await sharp(SAMPLE).resize({ width: 1600 }).jpeg().toBuffer())
  await new Promise((res, rej) => imageToPdf([tmpjpg]).pipe(fs.createWriteStream(pdf)).on('finish', res).on('error', rej)); fs.rmSync(tmpjpg)
  out.push({ name: 'passport-scan.pdf', file: pdf, yes: true })
  // not passports
  await add('blank', await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#eee' } }).jpeg().toBuffer(), false)
  await add('portrait', await sharp(await portrait(1600)).jpeg().toBuffer(), false)
  await add('letter', await sharp(text(['Dear Sir or Madam,', 'We confirm the appointment of Ms. TEST GIRL on 12 MAR 2026.', 'Contract no 123456789, passport EP1234567 is attached.', 'Yours faithfully,', 'The Agency'])).jpeg().toBuffer(), false)
  await add('form-table', await sharp(text(Array.from({ length: 30 }, (_, i) => `ROW ${i} | NAME TEST ${i} | 0${i}${i}${i}1234567 | EP${1000 + i} | 2026-01-${String(i % 28 + 1).padStart(2, '0')}`))).jpeg().toBuffer(), false)
  await add('mrz-wrong-digit', await sharp(text(['PASSPORT COPY', '', L1, L2.replace('7408122', '7408123')], 1240, 400)).jpeg().toBuffer(), false)
  await add('mrz-lookalike-text', await sharp(text(['TRAVEL <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'SOMETHING<<ELSE<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', '1234567890123456789012345678901234567890123456'], 1240, 500)).jpeg().toBuffer(), false)
  await add('tiny-icon', await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a33' } }).png().toBuffer(), false, 'png')
  await add('screenshot-wide', await sharp(text(['Adal Keep', 'Profiles   Tasks   CVs', 'ABDI   EP1234567   Chosen'], 2400, 700)).png().toBuffer(), false, 'png')
  return out
}
