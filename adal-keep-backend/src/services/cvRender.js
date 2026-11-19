import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

// Her father's name as the emergency contact: his name and his father's (her surname),
// e.g. "ABAGOLE KEDIR". A saved name that was only his first name gets the surname too.
function fatherFull(p = {}) {
  const base = String(p.father_name || p.middle_name || '').trim()
  const sur = String(p.last_name || '').trim()
  if (!base) return ''
  return sur && !base.toUpperCase().split(/s+/).includes(sur.toUpperCase()) ? `${base} ${sur}` : base
}
function emergencyName(p = {}) {
  const e = String(p.emergency_name || '').trim()
  const bare = [p.father_name, p.middle_name].map(x => String(x || '').trim().toUpperCase()).filter(Boolean)
  return (!e || bare.includes(e.toUpperCase())) ? fatherFull(p) || e : e
}

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
export function resolveStoredPath(rawPath) {
  if (!rawPath) return null
  const cwd = process.cwd()
  const base = path.basename(rawPath)
  // Files a run attaches (profileFiles.js) are stored with their full path.
  if (path.isAbsolute(rawPath)) { try { if (fs.existsSync(rawPath)) return rawPath } catch {} }
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
async function imageDataUri(absPath, mime, maxPx, { trim = false, quality = 85, palette = false } = {}) {
  if (!absPath || !fs.existsSync(absPath)) return ''
  if (mime && !mime.startsWith('image/')) return fileToDataUri(absPath, mime)
  const key = absPath + ':' + fs.statSync(absPath).mtimeMs + ':' + maxPx + ':' + trim + ':' + quality + ':' + palette
  if (_shrunk.has(key)) return _shrunk.get(key)
  let uri
  try {
    const sharp = (await import('sharp')).default
    // Trimmed on its own first: sharp cannot trim and resize in one go, and a
    // blank picture has nothing to trim.
    let source = absPath
    if (trim) source = await sharp(absPath).rotate().trim({ background: '#ffffff', threshold: 25 }).toBuffer().catch(() => absPath)
    const img = (source === absPath ? sharp(absPath).rotate() : sharp(source)).resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
    const { hasAlpha } = await sharp(absPath).metadata()
    uri = hasAlpha   // transparent banners stay PNG
      ? 'data:image/png;base64,' + (await img.png({ compressionLevel: 9, palette }).toBuffer()).toString('base64')
      : 'data:image/jpeg;base64,' + (await img.jpeg({ quality, mozjpeg: true }).toBuffer()).toString('base64')
  } catch {
    uri = fileToDataUri(absPath, mime)
  }
  if (_shrunk.size > 200) _shrunk.delete(_shrunk.keys().next().value)
  _shrunk.set(key, uri)
  return uri
}

/**
 * A template's header and footer banners as the CV shows them (1600 px, light):
 * for the phones, which draw CVs themselves with the PC off (cloudSync).
 */
export async function bannersOf(template) {
  return {
    header: template?.header_path ? await imageDataUri(resolveStoredPath(template.header_path), null, 1600, { quality: 75, palette: true }) : '',
    footer: template?.footer_path ? await imageDataUri(resolveStoredPath(template.footer_path), null, 1600, { quality: 75, palette: true }) : '',
  }
}

async function renderPdfFirstPageToDataUri(pdfPath, maxPx = 1600, quality = 85) {
  try {
    const mupdf = await import('mupdf')
    const data = fs.readFileSync(pdfPath)
    const doc = mupdf.Document.openDocument(data, 'application/pdf')
    if (doc.countPages() === 0) return ''
    const page = doc.loadPage(0)
    const pix = page.toPixmap([2,0,0,2,0,0], mupdf.ColorSpace.DeviceRGB, false, true)
    const sharp = (await import('sharp')).default
    const jpg = await sharp(Buffer.from(pix.asPNG())).resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer()
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

// How sharp the pictures inside a CV are. A CV PDF must stay under 300 KB
// (it goes by WhatsApp / Telegram on slow lines): level 0 first, and a
// smaller level only when the PDF came out bigger (htmlToSmallPdf).
export const CV_MAX_BYTES = 300 * 1024
const LEVELS = [
  { scale: 0.8, q: 70, palette: true },
  { scale: 0.62, q: 62, palette: true },
  { scale: 0.48, q: 54, palette: true },
  { scale: 0.36, q: 46, palette: true },
]
const px = (n, L) => Math.round(n * L.scale)

export async function buildTemplateData(db, profile, template, overrides = {}, { level = 0 } = {}) {
  const L = LEVELS[Math.min(Math.max(level, 0), LEVELS.length - 1)]
  const pic = { quality: L.q, palette: L.palette }
  const photoFile    = await findProfileFile(db, profile.id, 'Photo')
  const fullBodyFile = await findProfileFile(db, profile.id, 'Full Body Photo')
  const passportFile = await findProfileFile(db, profile.id, 'Passport')

  const photoAbs    = photoFile    ? resolveStoredPath(photoFile.path)    : null
  const fullBodyAbs = fullBodyFile ? resolveStoredPath(fullBodyFile.path) : null
  const passportAbs = passportFile ? resolveStoredPath(passportFile.path) : null
  const headerFile = template.header_path || null
  const footerFile = template.footer_path || null
  // The five pictures are made side by side (each is shrunk once and kept: imageDataUri).
  const passportP = !passportAbs ? '' : (passportFile.mimetype || '').startsWith('image/')
    ? imageDataUri(passportAbs, passportFile.mimetype, px(1300, L), pic)
    : (passportFile.mimetype === 'application/pdf' || passportAbs.toLowerCase().endsWith('.pdf'))
      ? renderPdfFirstPageToDataUri(passportAbs, px(1300, L), L.q)
      : fileToDataUri(passportAbs, passportFile.mimetype)
  const [photoUrl, fullBodyUrl, passportUrl, headerUrl, footerUrl] = await Promise.all([
    photoAbs    ? imageDataUri(photoAbs, photoFile.mimetype, px(600, L), pic) : PHOTO_PH,
    fullBodyAbs ? imageDataUri(fullBodyAbs, fullBodyFile.mimetype, px(1000, L), { ...pic, trim: true }) : BODY_PH,
    passportP,
    // Header/footer banners span the page width: 1600 px is sharp at A4.
    headerFile ? imageDataUri(resolveStoredPath(headerFile), null, px(1600, L), pic) : '',
    footerFile ? imageDataUri(resolveStoredPath(footerFile), null, px(1600, L), pic) : '',
  ])
  // Where she stands in her full-body photo: found once here and kept, so the
  // page frames her at once (frameBody) instead of looking for her each time.
  const fullBodyBox = fullBodyAbs && fullBodyUrl !== BODY_PH ? await bodyBoxOf(fullBodyUrl) : ''

  const { fieldsFromContract } = await import('./contractFields.js')
  const merged = { ...profile, ...fieldsFromContract(profile), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== '' && v != null)) }
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
  // Height and weight: what is written, else her own believable numbers (services/bodySize.js).
  {
    const { withBodySize } = await import('./bodySize.js')
    Object.assign(merged, withBodySize(merged))
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
    WEIGHT:           merged.weight,
    HEIGHT:           merged.height,
    COMPLEXION:       merged.complexion || '',
    LIVING_TOWN:      merged.living_town || '',
    MOTHER_NAME:      merged.mother_name || '',
    FATHER_NAME:      merged.father_name || '',
    SPOUSE_NAME:      merged.spouse_name || '',
    PHONE:            merged.phone_number || '',
    // Education: Preparatory when nothing (or the old placeholder "New") is filled in.
    EDUCATION:        (merged.education_level && !/^new$/i.test(String(merged.education_level).trim())) ? merged.education_level : 'Preparatory', /* EDUCATION_DEFAULT_PATCH */
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
    FULL_BODY_BOX:    fullBodyBox,
    PASSPORT_URL:     passportUrl,
    HEADER_IMAGE:     headerUrl,
    FOOTER_IMAGE:     footerUrl,
    LOGO_URL:         '',
    LABOR_ID:         merged.labor_id || '',
    PERSONAL_NUMBER:  merged.personal_number || '',
    REGION:           merged.region || '',
    ZONE_SUBCITY:     merged.zone_subcity || '',
    EMERGENCY_NAME:   emergencyName(merged),
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

// The CV page is one A4 in the preview and in the PDF alike. The full-body
// photo fills its box without pushing the page taller (it takes the room left
// beside the table, whole: a photo often holds the face as well).
const PAGE_CSS = `
body{background:#fff!important;}
.cv-page{width:210mm!important;min-height:297mm!important;margin:0 auto!important;box-shadow:none!important;flex:none;}
.main-grid{align-items:stretch;}
.right-col{display:flex;flex-direction:column;}
.body-photo{position:relative;flex:1 1 auto;min-height:50mm;padding:0!important;overflow:hidden;background:#fff;}
.body-photo img{position:absolute;left:0;top:0;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important;}
/* Her photos are never cut: every picture on the CV shows whole in its box (asked on 2026-11-13). */
img{object-fit:contain!important;object-position:center!important;}
/* A design (.cv): the photos fill their frames, edge to edge (asked on 2026-11-18). */
.cv .ph img,.cv .fb img{width:100%!important;height:100%!important;object-fit:cover!important;object-position:center top!important;}
.cv{margin:0 auto;}
`
// Templates whose photos were capped small (Al-Shahd and those made like it).
const WIDE_PHOTOS_CSS = `
.cv-body{display:flex;flex-direction:column;}
.main-grid{flex:1 1 auto;}
.left-col{flex:1 1 0;min-width:0;display:flex;}
.left-col .details{height:100%;}
.right-col{flex:0 0 62mm;}
.name-panel .inner{height:36mm;}
.headshot-cell{width:34mm;padding:0!important;}
.headshot-cell img{display:block;width:100%;max-width:none;height:40mm;object-fit:contain;object-position:center;background:#fff;border:0;}
`
// Runs in the preview and before the PDF, so both show the same page. A CV too
// tall for A4 first loses cell padding, then shrinks its body; one that fits is
// left alone.
const FIT_SCRIPT = `<script>(function(){
function personBox(img){
  // Found already on the PC (data-adal-box: x0,y0,x1,y1,w,h of this very picture, or none).
  var a=img.getAttribute('data-adal-box');
  if(a==='none')return null;
  if(a){var v=a.split(',').map(Number);if(v.length===6&&v.every(isFinite)&&v[4]===img.naturalWidth&&v[5]===img.naturalHeight)return {x0:v[0],y0:v[1],x1:v[2],y1:v[3],w:v[4],h:v[5]}}
  // Where she stands in the picture (natural px): the pixels that differ from the
  // background, which is read row by row from the left and right edges (a wall and
  // a floor of different colours both work). null when it cannot tell.
  var nw=img.naturalWidth,nh=img.naturalHeight;if(!nw||!nh)return null;
  var k=Math.min(1,160/Math.max(nw,nh)),w=Math.max(8,Math.round(nw*k)),h=Math.max(8,Math.round(nh*k));
  var c=document.createElement('canvas');c.width=w;c.height=h;var x=c.getContext('2d',{willReadFrequently:true});
  try{x.drawImage(img,0,0,w,h);var d=x.getImageData(0,0,w,h).data}catch(e){return null}
  return adalBoxOf(d,w,h,k,nw,nh);
}
function adalBoxOf(d,w,h,k,nw,nh){
  var s=Math.max(2,Math.round(w*0.04)),L=[],R=[],y,i,o,j;
  for(y=0;y<h;y++){var l=[0,0,0],r=[0,0,0],n=0;
    for(j=Math.max(0,y-2);j<=Math.min(h-1,y+2);j++)for(i=0;i<s;i++){o=(j*w+i)*4;l[0]+=d[o];l[1]+=d[o+1];l[2]+=d[o+2];o=(j*w+w-1-i)*4;r[0]+=d[o];r[1]+=d[o+1];r[2]+=d[o+2];n++}
    L.push([l[0]/n,l[1]/n,l[2]/n]);R.push([r[0]/n,r[1]/n,r[2]/n])}
  // her pixels differ from both edges of their row (a wall, a floor, a backdrop's dark edge)
  var dist=function(o,a){var dr=d[o]-a[0],dg=d[o+1]-a[1],db=d[o+2]-a[2];return Math.sqrt(dr*dr+dg*dg+db*db)};
  var T=[];for(y=0;y<h;y++){var nz=0,m=0;for(j=Math.max(0,y-2);j<=Math.min(h-1,y+2);j++)for(i=0;i<s;i++){nz+=dist((j*w+i)*4,L[y])+dist((j*w+w-1-i)*4,R[y]);m+=2}T.push(Math.max(28,2.5*nz/m+12))}
  var col=[],fg=new Uint8Array(w*h),all=0;for(i=0;i<w;i++)col.push(0);
  for(y=0;y<h;y++)for(i=s;i<w-s;i++){o=(y*w+i)*4;if(Math.min(dist(o,L[y]),dist(o,R[y]))>T[y]){fg[y*w+i]=1;col[i]++;all++}}
  var best=0;for(i=1;i<w;i++)if(col[i]>col[best])best=i;
  if(col[best]<h*0.25)return null;
  // every column with much of her in it stays (a shadow beside her may widen the box: never narrower)
  var min=Math.max(h*0.08,col[best]*0.3),x0=-1,x1=-1;
  for(i=0;i<w;i++)if(col[i]>min){if(x0<0)x0=i;x1=i}
  var rowOn=function(y){var n=0;for(var i=x0;i<=x1;i++)n+=fg[y*w+i];return n>Math.max(1,(x1-x0+1)*0.04)};
  var y0=0,y1=h-1;
  for(y=0;y<h-2;y++)if(rowOn(y)&&rowOn(y+1)&&rowOn(y+2)){y0=y;break}
  for(y=h-1;y>1;y--)if(rowOn(y)&&rowOn(y-1)&&rowOn(y-2)){y1=y;break}
  var inBox=0;for(y=y0;y<=y1;y++)for(i=x0;i<=x1;i++)inBox+=fg[y*w+i];
  if(inBox<all*0.85)return null;
  if((x1-x0+1)<w*0.1||(y1-y0+1)<h*0.4)return null;
  return {x0:x0/k,y0:y0/k,x1:(x1+1)/k,y1:(y1+1)/k,w:nw,h:nh};
}
function frameBody(img){
  // Her full-body photo framed head to feet, centred on her: the empty sides of a
  // wide photo are cut, never her head or her feet (a little room is kept around).
  var b=img._adalBox;if(b===undefined)b=img._adalBox=personBox(img);if(!b)return;
  var r=img.getBoundingClientRect();if(!r.width||!r.height)return;
  var A=r.width/r.height,nw=b.w,nh=b.h,bh=b.y1-b.y0;
  // a picture sized by itself (width/height auto): framed to the box it sits in
  var q=img.parentElement&&img.parentElement.getBoundingClientRect();
  if(q&&q.width&&q.height&&Math.abs(A-nw/nh)<nw/nh*0.02)A=q.width/q.height;
  // Sideways she is cut to her box; above her head only a little empty wall goes,
  // and nothing below: shoes on a dark floor are easy to miss, so her feet stay.
  var x0=Math.max(0,b.x0-bh*0.06),x1=Math.min(nw,b.x1+bh*0.06),y0=b.y0-bh*0.07,y1=nh;
  y0=y0<nh*0.04?0:Math.min(y0,nh*0.12);
  var cw=x1-x0,ch=y1-y0,cx=(x0+x1)/2,cy=(y0+y1)/2;
  if(cw/ch<A){cw=Math.min(nw,ch*A);x0=Math.max(0,Math.min(nw-cw,cx-cw/2));x1=x0+cw}
  else{ch=Math.min(nh,cw/A);y0=Math.max(0,Math.min(nh-ch,cy-ch/2));y1=y0+ch}
  var pc=function(v,t){return Math.max(0,v/t*100).toFixed(2)+'%'};
  var st=img.style;
  if(window.CSS&&CSS.supports&&CSS.supports('object-view-box','inset(1%)')){
    st.setProperty('object-view-box','inset('+pc(y0,nh)+' '+pc(nw-x1,nw)+' '+pc(nh-y1,nh)+' '+pc(x0,nw)+')','important');
  }else if(!img._adalCut){
    var c=document.createElement('canvas');c.width=Math.round(x1-x0);c.height=Math.round(y1-y0);
    try{c.getContext('2d').drawImage(img,x0,y0,x1-x0,y1-y0,0,0,c.width,c.height);img._adalCut=1;img._adalBox=null;img.removeAttribute('data-adal-box');img.src=c.toDataURL('image/jpeg',0.88)}catch(e){}
  }
  st.setProperty('object-fit','contain','important');st.setProperty('object-position','center','important');
}
function frameBodies(){var l=document.querySelectorAll('img[data-adal-body]');for(var i=0;i<l.length;i++)frameBody(l[i])}
function fitDesign(){
  // A page made from a design (.cv): its full-body photo frame takes exactly the
  // room the header and the other blocks leave, so the design fills the whole
  // A4 page at full width — never shrunk to fit (that left the right side empty).
  var p=document.querySelector('.adal-page'),b=p&&p.querySelector('.adal-body'),fb=b&&b.querySelector('.cv .fb');
  if(!fb||p.dataset.fitted)return false;p.dataset.fitted='1';
  var limit=Math.floor(297*96/25.4),min=Math.round(45*96/25.4);
  for(var i=0;i<3;i++){
    var top=p.getBoundingClientRect().top,last=b.lastElementChild,bottom=0;
    for(var c=b.firstElementChild;c;c=c.nextElementSibling)bottom=Math.max(bottom,c.getBoundingClientRect().bottom-top);
    var d=limit-2-Math.ceil(bottom);if(Math.abs(d)<2)break;
    var h=Math.max(min,fb.getBoundingClientRect().height+d);fb.style.setProperty('height',h+'px','important');
    if(h===min)break;
  }
  var z=100;while(z>70&&b.scrollHeight>limit+1){z-=3;b.style.zoom=z/100}
  p.style.height='297mm';p.style.maxHeight='297mm';p.style.overflow='hidden';
  return true;
}
function fit(){
  frameBodies();
  if(fitDesign()){frameBodies();return}
  var p=document.querySelector('.cv-page');if(!p||p.dataset.fitted){frameBodies();return}p.dataset.fitted='1';
  var limit=Math.floor(297*96/25.4)+1,tall=function(){return p.scrollHeight>limit};
  var st=document.createElement('style');document.head.appendChild(st);
  for(var n=6;n>=2&&tall();n--)st.textContent='.cv-page td{padding-top:'+n+'px!important;padding-bottom:'+n+'px!important}';
  var b=p.querySelector('.cv-body')||p;
  for(var z=98;z>=60&&tall();z-=2)b.style.zoom=z/100;
  p.style.height='297mm';p.style.overflow='hidden';
  frameBodies();
}
window.adalFit=fit;
if(document.readyState==='complete')fit();else addEventListener('load',fit);
})()</script>`

// The same search for her as the page's (adalBoxOf in FIT_SCRIPT), run here on
// the picture the CV shows: its answer goes into the page (data-adal-box).
const adalBoxOf = new Function(FIT_SCRIPT.slice(FIT_SCRIPT.indexOf('function adalBoxOf('), FIT_SCRIPT.indexOf('function frameBody(')) + 'return adalBoxOf')()
const _boxes = new Map()
export async function bodyBoxOf(uri) {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/.exec(uri || '')
  if (!m) return ''
  const key = createHash('sha1').update(m[1]).digest('hex')
  if (_boxes.has(key)) return _boxes.get(key)
  let out = ''
  try {
    const sharp = (await import('sharp')).default
    const buf = Buffer.from(m[1], 'base64')
    const { width: nw, height: nh } = await sharp(buf).metadata()
    const k = Math.min(1, 160 / Math.max(nw, nh)), w = Math.max(8, Math.round(nw * k)), h = Math.max(8, Math.round(nh * k))
    const d = await sharp(buf).resize(w, h, { fit: 'fill', kernel: 'linear' }).ensureAlpha().raw().toBuffer()
    const b = adalBoxOf(d, w, h, k, nw, nh)
    out = b ? [b.x0, b.y0, b.x1, b.y1, b.w, b.h].map(v => Math.round(v * 100) / 100).join(',') : 'none'
  } catch { out = '' }
  if (_boxes.size > 200) _boxes.delete(_boxes.keys().next().value)
  _boxes.set(key, out)
  return out
}

export function mergeTemplate(html, css, data) {
  let out = splitLanguageCells(html || '')

  // Base CSS — force A4 tall page
  const baseCss = `html,body{margin:0;padding:0;min-height:297mm;box-sizing:border-box;} @page{size:A4;margin:0;} body{display:flex;flex-direction:column;min-height:297mm;} .adal-page{flex:1;display:flex;flex-direction:column;} .adal-body{flex:1;}`
  const combinedCss = baseCss + '\n' + (css || '') + PAGE_CSS + (/max-height:\s*220px/.test(css || '') ? WIDE_PHOTOS_CSS : '')

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

  // Her full-body photo is framed on her by the page itself (frameBody in FIT_SCRIPT).
  const box = /^[0-9.,]+$|^none$/.test(data.FULL_BODY_BOX || '') ? ` data-adal-box="${data.FULL_BODY_BOX}"` : ''
  out = out.replace(/<img\b(?=[^>]*\{\{FULL_BODY_PHOTO_URL\}\})/gi, `<img data-adal-body="1"${box}`)

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
      '<div style="page-break-before:always;flex:none;margin:0 auto;width:210mm;height:297mm;padding:8px 16px;box-sizing:border-box;display:flex;flex-direction:column;background:#fff;">' +
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

  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, FIT_SCRIPT + '</body>') : out + FIT_SCRIPT
}

// One headless browser kept warm for PDFs: starting a browser per CV cost
// ~3 s. It closes itself after 5 idle minutes.
let _pdfBrowser = null
let _idle = null
let _launching = null
async function pdfBrowser() {
  if (_pdfBrowser?.connected) return _pdfBrowser
  // Two PDFs asked at once share one start.
  return _launching ||= (async () => {
    const exec = findBrowser()
    if (!exec) throw new Error('No Chrome/Edge/Chromium found for PDF rendering')
    const puppeteer = (await import('puppeteer-core')).default
    _pdfBrowser = await puppeteer.launch({ executablePath: exec, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    return _pdfBrowser
  })().finally(() => { _launching = null })
}
/** The CV page opened: the PDF browser starts now (~1-3 s), not when Download is pressed. */
export function warmPdfBrowser() {
  clearTimeout(_idle)
  return pdfBrowser().then(() => {
    _idle = setTimeout(() => { _pdfBrowser?.close().catch(() => {}); _pdfBrowser = null }, 5 * 60000)
    _idle.unref?.()
    return true
  }, () => false)
}

export async function htmlToPdf(html, outPath) {
  clearTimeout(_idle)
  const browser = await pdfBrowser()
  const page = await browser.newPage()
  try {
    // Everything is inline (data: images), so "load" is enough.
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 })
    await page.evaluate(() => window.adalFit?.())
    // Every CV fits its page, whatever the template: the CV page shrinks until
    // it is no taller than A4 and is cut to A4 exactly — so nothing spills
    // over into an (almost) blank page.
    const pages = await page.evaluate(() => {
      const A4 = Math.floor(297 * 96 / 25.4)
      for (const el of [document.documentElement, document.body]) { el.style.minHeight = '0'; el.style.height = 'auto' }
      const first = document.querySelector('.cv-page') || document.querySelector('.adal-page')
      if (first) {
        const body = first.querySelector('.cv-body, .adal-body') || first
        if (!first.dataset.fitted) for (let z = 100; z >= 55 && first.scrollHeight > A4 + 1; z -= 3) body.style.zoom = z / 100
        Object.assign(first.style, { height: '297mm', maxHeight: '297mm', overflow: 'hidden', boxSizing: 'border-box', breakAfter: 'auto', pageBreakAfter: 'auto' })
      }
      // The pages it is meant to have: the CV, and each page that starts a new one (the passport).
      const breaks = [...document.querySelectorAll('body *')].filter(e => /always|page/.test(getComputedStyle(e).breakBefore) || getComputedStyle(e).pageBreakBefore === 'always').length
      return first ? 1 + breaks : 0
    }).catch(() => 0)
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      ...(pages > 0 ? { pageRanges: `1-${pages}` } : {}),
    })
  } finally {
    await page.close().catch(() => {})
    _idle = setTimeout(() => { _pdfBrowser?.close().catch(() => {}); _pdfBrowser = null }, 5 * 60000)
    _idle.unref?.()
  }
}

/**
 * A CV PDF under CV_MAX_BYTES: build(level) gives the CV's { html, data } with
 * its pictures at that level; the smallest level that fits is kept (the last
 * one is kept whatever its size). Returns the data of the PDF that was kept.
 *
 * The same CV made ready before (preparePdf: the preview opened) is not made
 * again: its PDF is copied (or waited for, while it is still being made).
 */
const _ready = new Map()   // sha1 of the CV's page -> { at, made: Promise<{ file, data }> }
const READY_MS = 10 * 60000
const READY_DIR = path.join(os.tmpdir(), 'adal-cv-ready')
function forgetOld() {
  for (const [k, v] of _ready) {
    if (Date.now() - v.at < READY_MS) continue
    _ready.delete(k)
    v.made.then(r => fs.promises.rm(r.file, { force: true })).catch(() => {})
  }
}
async function renderSmall(build, first, outPath) {
  let data = null
  for (let level = 0; level < LEVELS.length; level++) {
    const made = level === 0 ? first : await build(level)
    data = made.data
    await htmlToPdf(made.html, outPath)
    const size = fs.statSync(outPath).size
    if (size <= CV_MAX_BYTES) break
    if (level < LEVELS.length - 1) console.log(`[cv] ${Math.round(size / 1024)} KB is over ${CV_MAX_BYTES / 1024} KB - smaller pictures`)
  }
  return data
}
const keyOf = (html) => createHash('sha1').update(html).digest('hex')

export async function htmlToSmallPdf(build, outPath) {
  const first = await build(0)
  const hit = _ready.get(keyOf(first.html))
  if (hit) {
    try {
      const r = await hit.made
      await fs.promises.copyFile(r.file, outPath)
      return r.data
    } catch { /* not made after all: made here */ }
  }
  return renderSmall(build, first, outPath)
}

/**
 * Makes the PDF of this CV now, behind (the person is looking at the preview):
 * Download / Save as then only copy it. Nothing is saved on her profile here.
 */
export async function preparePdf(build) {
  forgetOld()
  const first = await build(0)
  const key = keyOf(first.html)
  if (_ready.has(key)) return key
  fs.mkdirSync(READY_DIR, { recursive: true })
  const file = path.join(READY_DIR, `${key}.pdf`)
  const made = renderSmall(build, first, file).then(data => ({ file, data }))
  made.catch(() => _ready.delete(key))
  _ready.set(key, { at: Date.now(), made })
  return key
}

export async function isGeneratedCV(db, filename) {
  if (!filename) return false
  if (/^AdalCV_/i.test(filename)) return true
  try {
    const row = await db('generated_cvs').where('filename', filename).first()
    return !!row
  } catch { return false }
}
