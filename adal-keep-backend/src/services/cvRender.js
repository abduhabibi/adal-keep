import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

// Inline SVG placeholders — avoids broken image icons
function placeholderSvg(label, w = 200, h = 250) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#9ca3af">${label}</text></svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}
export const DEFAULT_SKILLS = { cleaning: true, ironing: true, washing: true, baby_sitting: true }
const PHOTO_PH = placeholderSvg('No photo')
const BODY_PH  = placeholderSvg('No full-body photo', 200, 400)
const HEADER_PH = placeholderSvg('No header image', 800, 100)
const FOOTER_PH = placeholderSvg('No footer image', 800, 60)

function findBrowser() {
  const c = []
  if (process.platform === 'win32') {
    const pf   = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const la   = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
    c.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )
  } else if (process.platform === 'darwin') {
    c.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser')
  }
  return c.find(p => { try { return fs.existsSync(p) } catch { return false } }) || null
}

// Resolve a DB `path` to an absolute file — handles both upload roots.
function resolveStoredPath(rawPath) {
  if (!rawPath) return null
  const cwd = process.cwd()
  const base = path.basename(rawPath)
  const candidates = [
    path.join(cwd, 'data/SafeStorage', rawPath),
    path.join(cwd, rawPath),
    path.join(cwd, 'data/SafeStorage', base),
    path.join(cwd, 'uploads', base),
  ]
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}

function fileToDataUri(absPath, mime) {
  if (!absPath || !fs.existsSync(absPath)) return ''
  const b64 = fs.readFileSync(absPath).toString('base64')
  const m = mime || (absPath.match(/\.png$/i) ? 'image/png' : 'image/jpeg')
  return `data:${m};base64,${b64}`
}

// Phone photos are 3-12 MB; a CV prints them a few centimetres wide. Shrink
// once (cached by path + modified time) so preview and PDF are light and fast.
const _shrunk = new Map()
async function imageDataUri(absPath, mime, maxPx) {
  if (!absPath || !fs.existsSync(absPath)) return ''
  if (mime && !mime.startsWith('image/')) return fileToDataUri(absPath, mime)
  const key = absPath + ':' + fs.statSync(absPath).mtimeMs + ':' + maxPx
  if (_shrunk.has(key)) return _shrunk.get(key)
  let uri
  try {
    const sharp = (await import('sharp')).default
    const img = sharp(absPath).rotate().resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    const { hasAlpha } = await sharp(absPath).metadata()
    uri = hasAlpha   // transparent banners stay PNG
      ? 'data:image/png;base64,' + (await img.png({ compressionLevel: 9 }).toBuffer()).toString('base64')
      : 'data:image/jpeg;base64,' + (await img.jpeg({ quality: 85 }).toBuffer()).toString('base64')
  } catch {
    uri = fileToDataUri(absPath, mime)
  }
  if (_shrunk.size > 200) _shrunk.delete(_shrunk.keys().next().value)
  _shrunk.set(key, uri)
  return uri
}

async function renderPdfFirstPageToDataUri(pdfPath) {
  try {
    const mupdf = await import('mupdf')
    const data = fs.readFileSync(pdfPath)
    const doc = mupdf.Document.openDocument(data, 'application/pdf')
    if (doc.countPages() === 0) return ''
    const page = doc.loadPage(0)
    const pix = page.toPixmap([2,0,0,2,0,0], mupdf.ColorSpace.DeviceRGB, false, true)
    const sharp = (await import('sharp')).default
    const jpg = await sharp(Buffer.from(pix.asPNG())).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    return 'data:image/jpeg;base64,' + jpg.toString('base64')
  } catch (e) {
    console.warn('[cvRender] PDF render failed:', e.message)
    return ''
  }
}

async function findProfileFile(db, profileId, fieldName) {
  const rows = await db('files')
    .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId)
    .andWhere('profile_fields.name', fieldName)
    .select('files.*')
    .orderBy('files.id', 'desc')
  if (!rows.length) return null
  // Prefer image over PDF (browser <img> can't render PDFs)
  const image = rows.find(r => (r.mimetype || '').startsWith('image/'))
  return image || rows[0]
}

function computeAge(dob) {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d)) return ''
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return String(age)
}

function formatDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt)) return d
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  return `${String(dt.getDate()).padStart(2, '0')} ${months[dt.getMonth()]} ${dt.getFullYear()}`
}

export async function buildTemplateData(db, profile, template, overrides = {}) {
  const photoFile    = await findProfileFile(db, profile.id, 'Photo')
  const fullBodyFile = await findProfileFile(db, profile.id, 'Full Body Photo')
  const passportFile = await findProfileFile(db, profile.id, 'Passport')

  const photoAbs    = photoFile    ? resolveStoredPath(photoFile.path)    : null
  const fullBodyAbs = fullBodyFile ? resolveStoredPath(fullBodyFile.path) : null
  const passportAbs = passportFile ? resolveStoredPath(passportFile.path) : null
  const photoUrl    = photoAbs    ? await imageDataUri(photoAbs, photoFile.mimetype, 800)       : PHOTO_PH
  const fullBodyUrl = fullBodyAbs ? await imageDataUri(fullBodyAbs, fullBodyFile.mimetype, 1400) : BODY_PH
  let passportUrl = ''
  if (passportAbs) {
    if ((passportFile.mimetype || '').startsWith('image/')) {
      passportUrl = await imageDataUri(passportAbs, passportFile.mimetype, 1600)
    } else if (passportFile.mimetype === 'application/pdf' || passportAbs.toLowerCase().endsWith('.pdf')) {
      passportUrl = await renderPdfFirstPageToDataUri(passportAbs)
    } else {
      passportUrl = fileToDataUri(passportAbs, passportFile.mimetype)
    }
  }

  const headerFile = template.header_path || null
  const footerFile = template.footer_path || null
  // Header/footer banners span the page width: 2000 px is sharp at A4.
  const headerUrl = headerFile ? await imageDataUri(resolveStoredPath(headerFile), null, 2000) : ''
  const footerUrl = footerFile ? await imageDataUri(resolveStoredPath(footerFile), null, 2000) : ''

  const merged = { ...profile, ...overrides }
  const parse = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback) } catch { return fallback } }

  // Skills: what the CV form sent; else what the profile saved; else the
  // form's own defaults (the four housework skills ticked).
  let skills = parse(overrides.skills, null) || parse(profile.skills, null)
  if (!skills || !Object.values(skills).some(Boolean)) skills = { ...DEFAULT_SKILLS }
  const cookingLevel = merged.cooking_skill && merged.cooking_skill !== 'None' ? merged.cooking_skill : ''
  if (cookingLevel) skills = { ...skills, cooking: true }

  // Experience abroad: the CV form's list, else the profile's
  // "Have experience" country and years.
  let prev = parse(overrides.previous_employment, null) || parse(profile.previous_employment, []) || []
  if (!prev.length && /^have/i.test(merged.work_experience || '') && merged.experience_country) {
    prev = [{ country: merged.experience_country, years: merged.experience_years }]
  }
  const prev0 = prev[0] || {}
  const prevPeriod = prev0.period ||
    (prev0.from || prev0.to ? [prev0.from, prev0.to].filter(Boolean).map(d => String(d).slice(0, 4)).join(' – ') : '') ||
    (prev0.years ? `${prev0.years} year${Number(prev0.years) === 1 ? '' : 's'}` : '')

  // BROKER_PHONE_FALLBACK — contact number falls back to broker's phone
  let brokerPhone = ''
  if (profile.broker_id) {
    try {
      const b = await db('brokers').where('id', profile.broker_id).first()
      brokerPhone = b?.contact1 || ''
    } catch {}
  }
  if (!merged.phone_number && brokerPhone) {
    merged.phone_number = brokerPhone
  }
  // Living town is no longer asked: the region (from the passport) stands in.
  if (!merged.living_town) merged.living_town = merged.zone_subcity || merged.region || merged.place_of_birth || ''
  if (!merged.height || merged.height === '--') {
    merged.height = 'Normal'
  }

  // A sentence from the ticked skills, e.g. "She can do cleaning, ironing and cooking."
  const skillLabels = { cleaning: 'cleaning', ironing: 'ironing', washing: 'washing', baby_sitting: 'baby sitting', cooking: (cookingLevel || 'cooking').toLowerCase() }
  const checked = Object.keys(skillLabels).filter(k => skills[k]).map(k => skillLabels[k])
  const remarks = !checked.length ? ''
    : checked.length === 1 ? `She can do ${checked[0]}.`
    : `She can do ${checked.slice(0, -1).join(', ')} and ${checked[checked.length - 1]}.`

  return {
    REMARKS:         merged.remarks || remarks,
    FULL_NAME:        merged.full_name || '',
    GIVEN_NAMES:      merged.first_name || merged.given_names || '',
    SURNAME:          merged.last_name  || '',
    NATIONALITY:      merged.nationality || 'ETHIOPIAN',
    SEX:              merged.gender || merged.sex || '',
    DOB:              formatDate(merged.date_of_birth),
    AGE:              computeAge(merged.date_of_birth),
    PASSPORT_NO:      merged.passport_number || '',
    PASSPORT_ISSUE_DATE:  formatDate(merged.passport_issue_date),
    PASSPORT_EXPIRY_DATE: formatDate(merged.passport_expiry_date),
    PLACE_OF_BIRTH:   merged.place_of_birth || '',
    RELIGION:         merged.religion || '',
    MARITAL_STATUS:   merged.marital_status || 'SINGLE',
    CHILDREN_COUNT:   merged.children_count == null || merged.children_count === '' ? 'None' : String(merged.children_count),
    WEIGHT:           merged.weight || 'Normal',
    HEIGHT:           merged.height || 'Normal',
    COMPLEXION:       merged.complexion || '',
    LIVING_TOWN:      merged.living_town || '',
    MOTHER_NAME:      merged.mother_name || '',
    FATHER_NAME:      merged.father_name || '',
    SPOUSE_NAME:      merged.spouse_name || '',
    PHONE:            merged.phone_number || '',
    EDUCATION:        merged.education_level || 'New', /* EDUCATION_DEFAULT_PATCH */
    // One cell per language: what she can do ("SPEAK", "SPEAK, READ, WRITE"), else NO.
    ENGLISH:          languageText(merged, 'english'),
    ARABIC:           languageText(merged, 'arabic'),
    ENGLISH_SPEAK:    yes(merged.speaks_english),
    ENGLISH_READ:     yes(merged.english_read),
    ENGLISH_WRITE:    yes(merged.english_write),
    ARABIC_SPEAK:     yes(merged.speaks_arabic),
    ARABIC_READ:      yes(merged.arabic_read),
    ARABIC_WRITE:     yes(merged.arabic_write),
    POST_APPLIED:     overrides.post_applied || 'HOUSE MAID',
    SALARY:           String(overrides.salary ?? template.salary ?? ''),
    CURRENCY:         overrides.currency || template.currency || 'SAR',
    COUNTRY:          overrides.country || template.country || '',
    CONTRACT_YEARS:   String(overrides.contract_years || template.contract_years || 2),
    REF_NO:           overrides.ref_no || '',
    DATE_TODAY:       new Date().toISOString().slice(0, 10),
    SKILL_CLEANING:      skills.cleaning     ? '✓' : '',
    SKILL_IRONING:       skills.ironing      ? '✓' : '',
    SKILL_WASHING:       skills.washing      ? '✓' : '',
    SKILL_BABY_SITTING:  skills.baby_sitting ? '✓' : '',
    SKILL_COOKING:       skills.cooking      ? '✓' : '',
    PREV_COUNTRY:     prev0.country  || '-',
    PREV_PERIOD:      prevPeriod     || '-',
    PREV_POSITION:    prev0.position || '-',
    PHOTO_URL:        photoUrl,
    FULL_BODY_PHOTO_URL: fullBodyUrl,
    PASSPORT_URL:     passportUrl,
    HEADER_IMAGE:     headerUrl,
    FOOTER_IMAGE:     footerUrl,
    LOGO_URL:         '',
    LABOR_ID:         merged.labor_id || '',
    PERSONAL_NUMBER:  merged.personal_number || '',
    REGION:           merged.region || '',
    ZONE_SUBCITY:     merged.zone_subcity || '',
    EMERGENCY_NAME:   (merged.emergency_name && String(merged.emergency_name).trim()) || merged.father_name || '',
    EMERGENCY_PHONE:  merged.emergency_phone || '',
    EMERGENCY_GENDER: merged.emergency_gender || 'Male',
    EMERGENCY_RELATIONSHIP: merged.emergency_relationship || 'Father',
    COOKING_SKILL:    merged.cooking_skill || 'None',
    PASSPORT_PAGE_INCLUDE:        !!template.include_passport && template.include_passport !== 0 && template.include_passport !== '0',
    PASSPORT_PAGE_INCLUDE_HEADER: template.passport_include_header !== false,
    PASSPORT_PAGE_INCLUDE_FOOTER: template.passport_include_footer !== false,
    PASSPORT_PAGE_H1:             (template.passport_h1 || '').trim(),
    PASSPORT_PAGE_H1_COLOR:       template.passport_h1_color || '#000000',
  }
}

const on = (v) => v === true || v === 1 || v === '1' || v === 'true'
const yes = (v) => (on(v) ? 'YES' : 'NO')
function languageText(p, lang) {
  const can = [on(lang === 'english' ? p.speaks_english : p.speaks_arabic) && 'SPEAK', on(p[`${lang}_read`]) && 'READ', on(p[`${lang}_write`]) && 'WRITE'].filter(Boolean)
  return can.length ? can.join(', ') : 'NO'
}

/**
 * Templates made before Speak / Read / Write were separate show {{ENGLISH}}
 * and {{ARABIC}} in their language grids. Each cell gets its own:
 *   - a row labelled Read / Write / Speak (قراءة / كتابة / محادثة): its
 *     {{ENGLISH}} / {{ARABIC}} — or its fixed YES / NO cells, English first —
 *     become that row's ENGLISH_READ … ARABIC_WRITE;
 *   - a row with {{ENGLISH}} (or {{ARABIC}}) several times under a header
 *     row SPEAK · READ · WRITE: each takes its column's.
 * Other {{ENGLISH}} / {{ARABIC}} stay one cell ("SPEAK, READ").
 */
export function splitLanguageCells(html) {
  const SKILL = { read: 'READ', write: 'WRITE', speak: 'SPEAK', 'قراءة': 'READ', 'كتابة': 'WRITE', 'محادثة': 'SPEAK' }
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
  let order = null
  return String(html || '').replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (row) => {
    const cells = row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []
    const words = cells.map(c => text(c).toLowerCase())
    // a header row: SPEAK READ WRITE in some order
    const heads = words.map(w => (/^(speak|read|write)\b/.test(w) ? w.match(/^(speak|read|write)/)[1].toUpperCase() : null))
    if (heads.filter(Boolean).length >= 2 && !/\{\{/.test(row)) { order = heads.filter(Boolean); return row }
    // a row labelled with one skill
    const first = (words[0] || '').split(' ')
    const skill = SKILL[first[0]] || SKILL[first[first.length - 1]]
    if (skill && cells.length >= 2) {
      let langs = ['ENGLISH', 'ARABIC'], i = 0
      return row.replace(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi, (cell, off) => {
        if (i++ === 0) return cell
        if (/\{\{(ENGLISH|ARABIC)\}\}/.test(cell)) return cell.replace(/\{\{(ENGLISH|ARABIC)\}\}/g, (_, l) => { langs = langs.filter(x => x !== l); return `{{${l}_${skill}}}` })
        if (/^(yes|no)$/i.test(text(cell)) && langs.length) { const l = langs.shift(); return cell.replace(/>(\s*)(yes|no)(\s*)</i, `>$1{{${l}_${skill}}}$3<`) }
        return cell
      })
    }
    // repeated cells under the header
    if (order) {
      let changed = row
      for (const l of ['ENGLISH', 'ARABIC']) {
        const re = new RegExp(`\\{\\{${l}\\}\\}`, 'g')
        if ((row.match(re) || []).length === order.length) { let k = 0; changed = changed.replace(re, () => `{{${l}_${order[k++]}}}`) }
      }
      return changed
    }
    return row
  })
}

export function mergeTemplate(html, css, data) {
  let out = splitLanguageCells(html || '')

  // Base CSS — force A4 tall page
  const baseCss = `html,body{margin:0;padding:0;min-height:297mm;box-sizing:border-box;} @page{size:A4;margin:0;} body{display:flex;flex-direction:column;min-height:297mm;} .adal-page{flex:1;display:flex;flex-direction:column;} .adal-body{flex:1;}`
  const combinedCss = baseCss + '\n' + (css || '')

  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `<style>${combinedCss}</style></head>`)
  else out = `<style>${combinedCss}</style>` + out

  // Wrap body content in .adal-page so header + footer can stick to top/bottom
  const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    const inner = bodyMatch[1]
    const wrapped = `<body><div class="adal-page"><div class="adal-body">${inner}</div></div></body>`
    out = out.replace(/<body[^>]*>[\s\S]*?<\/body>/i, wrapped)
  }

  // No header/footer image on this template: drop the <img> (an empty src
  // prints a broken-image box with its alt text).
  for (const k of ['HEADER_IMAGE', 'FOOTER_IMAGE']) {
    if (!data[k]) out = out.replace(new RegExp(`<img\\b[^>]*\\{\\{${k}\\}\\}[^>]*>`, 'gi'), '')
  }

  // Replace tokens
  out = out.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    const v = data[k]
    return v == null ? '' : String(v)
  })

  // If template didn't have a HEADER_IMAGE token, prepend one
  if (data.HEADER_IMAGE && !/\{\{HEADER_IMAGE\}\}/.test(html)) {
    const headerBlock = `<div style="width:100%;padding:0;margin:0;"><img src="${data.HEADER_IMAGE}" style="display:block;width:100%;height:auto;max-height:40mm;object-fit:contain;" /></div>`
    out = out.replace(/<div class="adal-body">/i, `<div class="adal-body">${headerBlock}`)
  }
  // If template didn't have a FOOTER_IMAGE token, append one
  if (data.FOOTER_IMAGE && !/\{\{FOOTER_IMAGE\}\}/.test(html)) {
    const footerBlock = `<div style="width:100%;padding:0;margin:0;"><img src="${data.FOOTER_IMAGE}" style="display:block;width:100%;height:auto;max-height:25mm;object-fit:contain;" /></div>`
    out = out.replace(/<\/div><\/body>/i, `${footerBlock}</div></body>`)
  }

  // AUTO_PASSPORT_PAGE — configurable header/footer/H1 per template
  if (data.PASSPORT_URL && data.PASSPORT_PAGE_INCLUDE) {
    const includeHeader = data.PASSPORT_PAGE_INCLUDE_HEADER !== false && !!data.HEADER_IMAGE
    const includeFooter = data.PASSPORT_PAGE_INCLUDE_FOOTER !== false && !!data.FOOTER_IMAGE
    const h1 = data.PASSPORT_PAGE_H1 || ''
    const h1Color = data.PASSPORT_PAGE_H1_COLOR || '#000000'

    const headerHtml = includeHeader
      ? '<div style="width:100%;"><img src="' + data.HEADER_IMAGE + '" style="display:block;width:100%;height:auto;" /></div>'
      : ''
    const footerHtml = includeFooter
      ? '<div style="width:100%;"><img src="' + data.FOOTER_IMAGE + '" style="display:block;width:100%;height:auto;" /></div>'
      : ''
    const h1Html = h1
      ? '<h1 style="font-family:Arial,sans-serif;font-size:22pt;font-weight:bold;color:' + h1Color + ';text-align:center;margin:6mm 0 4mm 0;letter-spacing:1px;">' + h1 + '</h1>'
      : ''

    const passportPage =
      '<div style="page-break-before:always;width:210mm;height:297mm;padding:8px 16px;box-sizing:border-box;display:flex;flex-direction:column;background:#fff;">' +
        headerHtml + h1Html +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:2mm 0;min-height:0;"><img src="' + data.PASSPORT_URL + '" style="max-width:100%;max-height:100%;object-fit:contain;" /></div>' +
        footerHtml +
      '</div>'

    // Bulletproof insertion — try </body>, then </html>, then just append
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, passportPage + '</body>')
    } else if (/<\/html>/i.test(out)) {
      out = out.replace(/<\/html>/i, passportPage + '</html>')
    } else {
      // No wrapper at all — build one and wrap everything
      out = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0;} html,body{margin:0;padding:0;}</style></head><body>' + out + passportPage + '</body></html>'
    }
  }

  return out
}

// One headless browser kept warm for PDFs: starting a browser per CV cost
// ~3 s. It closes itself after 5 idle minutes.
let _pdfBrowser = null
let _idle = null
async function pdfBrowser() {
  if (_pdfBrowser?.connected) return _pdfBrowser
  const exec = findBrowser()
  if (!exec) throw new Error('No Chrome/Edge/Chromium found for PDF rendering')
  const puppeteer = (await import('puppeteer-core')).default
  _pdfBrowser = await puppeteer.launch({ executablePath: exec, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  return _pdfBrowser
}

export async function htmlToPdf(html, outPath) {
  clearTimeout(_idle)
  const browser = await pdfBrowser()
  const page = await browser.newPage()
  try {
    // Everything is inline (data: images), so "load" is enough.
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 })
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })
  } finally {
    await page.close().catch(() => {})
    _idle = setTimeout(() => { _pdfBrowser?.close().catch(() => {}); _pdfBrowser = null }, 5 * 60000)
    _idle.unref?.()
  }
}

export async function isGeneratedCV(db, filename) {
  if (!filename) return false
  if (/^AdalCV_/i.test(filename)) return true
  try {
    const row = await db('generated_cvs').where('filename', filename).first()
    return !!row
  } catch { return false }
}
