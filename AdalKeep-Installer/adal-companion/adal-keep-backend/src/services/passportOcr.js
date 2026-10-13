import sharp from 'sharp'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWorker } from 'tesseract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LANG_PATH = path.join(__dirname, '../..')
const CACHE_PATH = path.join(__dirname, '../../data/tessdata')

const PHASE = { crop:[0,5], workerInit:[5,15], mrzOcr:[15,55], visualOcr:[55,95], post:[95,100] }
function pct(name, p) {
  const [s,e] = PHASE[name]
  return Math.round(s + (e-s) * Math.max(0, Math.min(1, p)))
}


function looksLikeMrz(text) {
  if (!text) return false
  for (const L of text.split(/\r?\n/)) {
    const c = L.replace(/\s/g, '').toUpperCase()
    if (c.length >= 30 && /^P[A-Z<][A-Z]{3}/.test(c)) return true
  }
  return false
}

async function tryMrzAtRotation(imagePath, angle, worker) {
  const tmp = path.join(os.tmpdir(), `adal_rot_${angle}_${Date.now()}.png`)
  try {
    await sharp(imagePath).rotate(angle).toFile(tmp)
    const meta = await sharp(tmp).metadata()
    const h = meta.height, w = meta.width
    const cropPath = path.join(os.tmpdir(), `adal_rotcrop_${angle}_${Date.now()}.png`)
    await sharp(tmp)
      .extract({ left: 0, top: Math.floor(h * 0.82), width: w, height: h - Math.floor(h * 0.82) })
      .resize({ width: w * 3, kernel: 'lanczos3' })
      .grayscale().normalize()
      .toFile(cropPath)
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    })
    const r = await worker.recognize(cropPath)
    try { fs.unlinkSync(tmp) } catch {}
    try { fs.unlinkSync(cropPath) } catch {}
    return { angle, text: r.data.text || '', ok: looksLikeMrz(r.data.text || '') }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    return { angle, text: '', ok: false }
  }
}

export async function extractPassport(imagePath, onProgress = () => {}) {
  onProgress(0)
  const meta = await sharp(imagePath).metadata()
  const w = meta.width, h = meta.height

  // ---- MRZ: crop from ORIGINAL, 3x upscale, grayscale+normalize (NO threshold) ----
  const mrzTop = Math.floor(h * 0.85)
  const mrzPath = path.join(os.tmpdir(), `adal_mrz_${Date.now()}.png`)
  await sharp(imagePath)
    .extract({ left: 0, top: mrzTop, width: w, height: h - mrzTop })
    .resize({ width: w * 3, kernel: 'lanczos3' })
    .grayscale()
    .normalize()
    .toFile(mrzPath)
  onProgress(pct('crop', 0.5))

  // ---- Visual: upscale ONLY for OCR input, but cap at 1600 so noise doesn't dominate ----
  let visSource = imagePath
  let visW = w, visH = h
  let tmpUp = null
  if (w < 1200) {
    const scale = 1600 / w
    visW = 1600; visH = Math.round(h * scale)
    tmpUp = path.join(os.tmpdir(), `adal_up_${Date.now()}.png`)
    await sharp(imagePath)
      .resize({ width: visW, height: visH, kernel: 'lanczos3', fit: 'fill' })
      .sharpen({ sigma: 0.6 })
      .toFile(tmpUp)
    visSource = tmpUp
    console.log(`[passportOcr] visual upscaled ${w}→${visW}`)
  } else {
    console.log(`[passportOcr] visual native ${visW}px`)
  }

  const visPath = path.join(os.tmpdir(), `adal_vis_${Date.now()}.png`)
  await sharp(visSource)
    .extract({ left: 0, top: 0, width: visW, height: Math.floor(visH * 0.88) })
    .grayscale()
    .normalize()
    .toFile(visPath)
  onProgress(pct('crop', 1))

  let phase = 'mrzOcr'
  const worker = await createWorker(['eng', 'amh'], 1, {
    logger: (m) => {
      const st = m.status || ''
      if (st === 'recognizing text') onProgress(pct(phase, m.progress))
      else if (/loading|initializing/.test(st)) onProgress(pct('workerInit', m.progress))
    },
    langPath: LANG_PATH, cachePath: CACHE_PATH, gzip: false,
  })

  let mrzText = ''
  try {
    // EXIF auto-rotate + try 0°, 90°, 180°, 270° — pick the first that yields
    // an MRZ-like line. Most phones set EXIF; the others need the fallback.
    const candidates = [0, 90, 180, 270]
    for (const angle of candidates) {
      const res = await tryMrzAtRotation(imagePath, angle, worker)
      if (res.ok) {
        mrzText = res.text
        if (angle !== 0) console.log('[passportOcr] MRZ found at rotation ' + angle + '°')
        break
      }
      if (angle === 0) mrzText = res.text  // keep 0° result as fallback
    }
  } catch (e) { console.warn('[passportOcr] MRZ pass:', e.message) }

  phase = 'visualOcr'
  let visualText = ''
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' })
    visualText = (await worker.recognize(visPath)).data.text || ''
  } catch (e) { console.warn('[passportOcr] visual pass:', e.message) }

  try { await worker.terminate() } catch {}
  for (const f of [mrzPath, visPath, tmpUp]) {
    if (f && f !== imagePath) try { fs.unlinkSync(f) } catch {}
  }
  onProgress(100)
  return { mrzText, visualText, combined: `${visualText}\n${mrzText}` }
}

// ---------------- Visual-zone extraction ----------------
const MONTHS = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' }

export function parseAnyDate(raw) {
  if (!raw) return null
  const s = String(raw).toUpperCase().replace(/[.,]/g,' ').replace(/\s+/g,' ').trim()
  let m = s.match(/(\d{1,2})\s*([A-Z]{3})[A-Z]*\s*(\d{2,4})/)
  if (m && MONTHS[m[2]]) {
    let yy = m[3]; if (yy.length===2) yy = parseInt(yy,10)>50?`19${yy}`:`20${yy}`
    return `${yy}-${MONTHS[m[2]]}-${String(parseInt(m[1],10)).padStart(2,'0')}`
  }
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/)
  if (m) {
    let [,a,b,y] = m, d, mo
    if (parseInt(a,10)>12){d=a;mo=b} else if (parseInt(b,10)>12){d=b;mo=a} else {d=a;mo=b}
    if (y.length===2) y = parseInt(y,10)>50?`19${y}`:`20${y}`
    return `${y}-${String(parseInt(mo,10)).padStart(2,'0')}-${String(parseInt(d,10)).padStart(2,'0')}`
  }
  m = s.match(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{4})\b/)
  if (m) {
    let [,a,b,y] = m, d, mo
    if (parseInt(a,10)>12){d=a;mo=b} else if (parseInt(b,10)>12){d=b;mo=a} else {d=a;mo=b}
    return `${y}-${String(parseInt(mo,10)).padStart(2,'0')}-${String(parseInt(d,10)).padStart(2,'0')}`
  }
  return null
}

function findAllDates(text) {
  const out = []
  for (const line of (text||'').split(/\r?\n/)) {
    if (!line || line.trim().length < 4) continue
    const toks = []
    let m
    const r1 = /\b(\d{1,2})\s*([A-Z]{3})[A-Z]*\s*(\d{2,4})\b/gi
    while ((m=r1.exec(line))!==null) toks.push(m[0])
    if (!toks.length) {
      const r2 = /\b(\d{1,2})[\/\-.]\s*(\d{1,2})[\/\-.]\s*(\d{2,4})\b/g
      while ((m=r2.exec(line))!==null) toks.push(m[0])
    }
    if (!toks.length) {
      const r3 = /\b(\d{1,2})\s+(\d{1,2})\s+(\d{4})\b/g
      while ((m=r3.exec(line))!==null) toks.push(m[0])
    }
    for (const tok of toks) {
      const iso = parseAnyDate(tok)
      if (iso) out.push({ iso, raw: tok, line: line.trim() })
    }
  }
  return out
}

const LABELS = {
  given_names:    [/Given\s*Names?/i, /First\s*Names?/i, /Names?\s*of\s*Holder/i],
  surname:        [/Surname/i, /Family\s*Name/i, /Last\s*Name/i],
  place_of_birth: [/Place\s*of\s*Birth/i, /Birth\s*Place/i],
  date_of_issue:  [/Date\s*of\s*Issue/i, /Issue\s*Date/i, /Issued?\s*on/i],
  date_of_expiry: [/Date\s*of\s*Expir/i, /Expiry\s*Date/i, /Expir(?:es|ation)/i],
  date_of_birth:  [/Date\s*of\s*Birth/i, /Birth\s*Date/i, /D\.?O\.?B\.?/i],
}
const NAME_BLOCKLIST = new Set([
  'SURNAME','GIVEN','NAME','NAMES','FIRST','LAST','FAMILY','NATIONALITY','SEX',
  'BIRTH','PLACE','ISSUE','ISSUED','EXPIRY','EXPIRES','DATE','FEDERAL','DEMOCRATIC',
  'REPUBLIC','ETHIOPIA','ETHIOPIAN','PASSPORT','IMMIGRATION','CITIZENSHIP','SERVICE',
  'AUTHORITY','TYPE','CODE','COUNTRY','HOLDER','MINISTRY','AFFAIRS',
])

function cleanNameToken(s) {
  if (!s) return null
  let t = s
  if (t.includes('/')) {
    const parts = t.split('/').map(x=>x.trim()).filter(Boolean)
    t = parts[parts.length-1]
  }
  t = t.replace(/[^A-Za-z'\- ]+/g,' ').replace(/\s+/g,' ').trim().toUpperCase()
  if (t.length < 2 || t.length > 45) return null
  if (!/[AEIOU]/.test(t)) return null
  const toks = t.split(' ').filter(x =>
    x.length >= 2 && !NAME_BLOCKLIST.has(x) && /^[A-Z][A-Z'\-]*$/.test(x) && /[AEIOU]/.test(x)
  )
  return toks.length ? toks.join(' ') : null
}

function dateValue(line) {
  if (!line) return null
  let m = line.match(/\b(\d{1,2})\s*([A-Z]{3})[A-Z]*\s*(\d{2,4})\b/i)
  if (m) return m[0]
  m = line.match(/\b(\d{1,2})[\/\-.]\s*(\d{1,2})[\/\-.]\s*(\d{2,4})\b/)
  if (m) return m[0]
  m = line.match(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{4})\b/)
  return m ? m[0] : null
}

function extractLabeledValue(text, patterns, extractor, maxLines = 3, window = 320) {
  if (!text) return null
  for (const pat of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags+'g')
    let m
    while ((m = re.exec(text)) !== null) {
      const from = m.index + m[0].length
      const slice = text.slice(from, from + window)
      const lines = slice.split(/\r?\n/)
      for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
        const line = (lines[i]||'').trim()
        if (!line) continue
        const v = extractor(line)
        if (v) return v
      }
    }
  }
  return null
}


// Find the first Amharic-only name after a label. Used to recover
// the Amharic transcript of "Given Names" and "Surname" from the
// bilingual passport visual zone.
function findAmharicAfter(text, labelRegexes, maxLines = 5, window = 400) {
  if (!text) return null
  for (const rx0 of labelRegexes) {
    const rx = new RegExp(rx0.source, rx0.flags.includes('g') ? rx0.flags : rx0.flags + 'g')
    let m
    while ((m = rx.exec(text)) !== null) {
      const slice = text.slice(m.index, m.index + window)
      const lines = slice.split(/\r?\n/)
      for (let i = 1; i < Math.min(lines.length, maxLines + 1); i++) {
        const line = (lines[i] || '').trim()
        if (!line) continue
        // Grab the first Amharic-only run of characters
        const am = line.match(/[\u1200-\u137F][\u1200-\u137F\s]{0,40}/g)
        if (am) {
          const joined = am.map(x => x.trim()).filter(Boolean).join(' ').trim()
          // Reject single-char noise and long garbage
          if (joined.length >= 2 && joined.length <= 40) return joined
        }
      }
    }
  }
  return null
}

export function extractVisualFields(visualText) {
  const t = visualText || ''
  const out = {}
  const gn = extractLabeledValue(t, LABELS.given_names, cleanNameToken)
  const sn = extractLabeledValue(t, LABELS.surname, cleanNameToken)
  if (gn) out.given_names = gn
  if (sn) out.surname = sn
  const pob = extractLabeledValue(t, LABELS.place_of_birth, cleanNameToken)
  if (pob) out.place_of_birth = pob
  const iTok = extractLabeledValue(t, LABELS.date_of_issue, dateValue)
  const eTok = extractLabeledValue(t, LABELS.date_of_expiry, dateValue)
  const bTok = extractLabeledValue(t, LABELS.date_of_birth, dateValue)
  if (iTok) out.date_of_issue = parseAnyDate(iTok)
  if (eTok) out.date_of_expiry = parseAnyDate(eTok)
  if (bTok) out.date_of_birth = parseAnyDate(bTok)
  out.dates_in_order = findAllDates(t)
  const surnameAm = findAmharicAfter(t, [/Surname/i, /Family\s*Name/i, /\u12E8\u12D8\u122D\s*\u1235\u121D/])
  const givenAm = findAmharicAfter(t, [/Given\s*Names?/i, /First\s*Names?/i, /\u12E8\u1218\u1320\u122A\u12EB\s*\u1235\u121D/])
  if (surnameAm) out.surname_am = surnameAm
  if (givenAm) out.given_names_am = givenAm
  const am = t.match(/[\u1200-\u137F][\u1200-\u137F\s]{1,40}/g) || []
  out.amharic_runs = am.map(x=>x.trim()).filter(Boolean)
  return out
}
