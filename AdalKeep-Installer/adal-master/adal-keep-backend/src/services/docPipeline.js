import fs from 'fs'
import { enqueueFile } from './ingestQueue.js'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import imageToPdf from 'image-to-pdf'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')
if (!fs.existsSync(SAFE_STORAGE_DIR)) fs.mkdirSync(SAFE_STORAGE_DIR, { recursive: true })

// Crop the headshot region out of a passport image.
// bbox = [x, y, w, h] as fractions 0-1. Falls back to top-left heuristic.
export async function cropPassportPhoto(sourceImagePath, bbox) {
  if (!sourceImagePath || !fs.existsSync(sourceImagePath)) return null
  const meta = await sharp(sourceImagePath).metadata()
  const imgW = meta.width || 0
  const imgH = meta.height || 0
  if (!imgW || !imgH) return null

  let left, top, width, height
  const valid = Array.isArray(bbox) && bbox.length === 4
    && bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1)
    && bbox[2] > 0.05 && bbox[3] > 0.05   // not a zero bbox

  if (valid) {
    left = Math.floor(bbox[0] * imgW)
    top = Math.floor(bbox[1] * imgH)
    width = Math.floor(bbox[2] * imgW)
    height = Math.floor(bbox[3] * imgH)
  } else {
    // Heuristic: left side of the data page, upper-middle band
    left = Math.floor(imgW * 0.05)
    top = Math.floor(imgH * 0.28)
    width = Math.floor(imgW * 0.24)
    height = Math.floor(imgH * 0.34)
  }

  // Clamp to image bounds
  if (left + width > imgW) width = imgW - left
  if (top + height > imgH) height = imgH - top
  if (width < 80 || height < 80) return null

  const outPath = sourceImagePath.replace(/\.(jpg|jpeg|png|webp)$/i, '_photo.jpg')
  try {
    await sharp(sourceImagePath)
      .extract({ left, top, width, height })
      .resize({ width: 400, kernel: 'lanczos3' })   // standard passport size
      .jpeg({ quality: 92 })
      .toFile(outPath)
    return outPath
  } catch (e) {
    console.error('[pipeline] crop failed:', e.message)
    return null
  }
}

export const ALLOWED_EXTS = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
}

// ---------- helpers ----------
const NON_NAME = ['pasted','image','scan','scanned','copy','document','screenshot','whatsapp','img','photo','picture','file','new','final','page','png','jpg','pdf','zm']
export function sanitizeName(raw) {
  if (!raw) return ''
  let b = String(raw).replace(/\s*\(\d+\)\s*/g, ' ').split(/[-–]\s*ZM/i)[0]
  b = b.replace(/[-\s]\d{2,}([-\s]\d{2,})+.*$/, '')
  const w = b.split(/[_\s]+/)
    .filter(x => /^[A-Za-z\u1200-\u137F]{2,}$/.test(x))
    .filter(x => !NON_NAME.includes(x.toLowerCase()))
  return w.length ? w.join(' ').toUpperCase() : ''
}
export function nameFromFilename(f) {
  let b = path.basename(f, path.extname(f)).replace(/^\d{10,}_/, '')
  return sanitizeName(b)
}
export function cleanPhone(p) {
  if (!p) return null
  const d = String(p).replace(/\D/g, '')
  if (d.startsWith('251') && d.length === 12) return `+${d}`
  if (d.length === 10 && (d.startsWith('09') || d.startsWith('07'))) return d
  if (d.length === 9 && (d.startsWith('9') || d.startsWith('7'))) return `0${d}`
  return null
}

// Force given-first, surname-last for every document type.
function normalizeNameOrder(ex) {
  if (!ex) return ex
  const fn = (ex.given_names || ex.first_name || '').toString().trim()
  const ln = (ex.surname     || ex.last_name  || '').toString().trim()
  if (fn || ln) {
    ex.given_names = fn || ex.given_names
    ex.first_name  = fn ? fn.split(/\s+/)[0] : ex.first_name
    ex.last_name   = ln || ex.last_name
    ex.full_name   = [fn, ln].filter(Boolean).join(' ').trim()
  }
  return ex
}

async function renderPdfPage(pdfPath, pageIndex = 0, scale = 3) {
  try {
    const mupdf = await import('mupdf')
    const data = fs.readFileSync(pdfPath)
    const doc = mupdf.Document.openDocument(data, 'application/pdf')
    if (doc.countPages() === 0 || pageIndex >= doc.countPages()) return null
    const page = doc.loadPage(pageIndex)
    const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
    const out = path.join(os.tmpdir(), `adal_pg_${Date.now()}_${pageIndex}.png`)
    fs.writeFileSync(out, Buffer.from(pix.asPNG()))
    return out
  } catch (e) {
    console.error('[pipeline] PDF render failed:', e.message)
    return null
  }
}

async function ensureBothFormats(originalPath, ext) {
  const out = []
  const dir = path.dirname(originalPath)
  const base = path.basename(originalPath, ext)
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    out.push({ path: originalPath, mimetype: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', name: path.basename(originalPath) })
    const pdfPath = path.join(dir, `${base}.pdf`)
    try {
      await new Promise((res, rej) => {
        imageToPdf([originalPath]).pipe(fs.createWriteStream(pdfPath))
          .on('finish', res).on('error', rej)
      })
      if (fs.existsSync(pdfPath)) out.push({ path: pdfPath, mimetype: 'application/pdf', name: `${base}.pdf` })
    } catch (e) { console.warn('[pipeline] imageToPdf failed:', e.message) }
  } else if (ext === '.pdf') {
    out.push({ path: originalPath, mimetype: 'application/pdf', name: path.basename(originalPath) })
    const png = await renderPdfPage(originalPath, 0, 3)
    if (png) {
      const finalPng = path.join(dir, `${base}.png`)
      fs.copyFileSync(png, finalPng)
      try { fs.unlinkSync(png) } catch {}
      out.push({ path: finalPng, mimetype: 'image/png', name: `${base}.png` })
    }
  }
  return out
}

// SLIP_ATTACH_MARKER — find the worker profile a slip belongs to
// Priority: reference_name (the worker) → last word of reference → full_name of customer
async function findSlipProfile(ex, db) {
  const candidates = []
  if (ex.reference_name) candidates.push(sanitizeName(ex.reference_name))
  if (ex.customer_name)  candidates.push(sanitizeName(ex.customer_name))
  candidates.push(sanitizeName(ex.full_name))

  for (const cand of candidates) {
    if (!cand || cand.length < 3) continue
    let hit = await db('profiles').where('full_name', 'like', '%' + cand + '%').first()
    if (hit) return hit
    const lastWord = cand.split(/\s+/).pop()
    if (lastWord && lastWord.length > 3) {
      hit = await db('profiles').where('full_name', 'like', '%' + lastWord + '%').first()
      if (hit) return hit
    }
  }
  return null
}

async function getOrCreateProfile(ex, fullName, db) {
  try {
    let p = null
    if (ex.passport_number) p = await db('profiles').where('passport_number', ex.passport_number).first()
    if (!p && ex.national_id) p = await db('profiles').where('national_id', ex.national_id).first()
    if (!p && fullName) p = await db('profiles').where('full_name', fullName).first()

    if (p) {
      const updates = {}
      if (fullName && fullName !== 'Unknown' && fullName !== p.full_name) updates.full_name = fullName
      if (ex.first_name && ex.first_name !== p.first_name) updates.first_name = ex.first_name
      if (ex.last_name  && ex.last_name  !== p.last_name)  updates.last_name  = ex.last_name
      if (Object.keys(updates).length) {
        updates.updated_at = new Date().toISOString()
        await db('profiles').where('id', p.id).update(updates)
        console.log(`[pipeline] repaired profile #${p.id}:`, JSON.stringify(updates))
      }
      return { ...p, ...updates }
    }

    if (!fullName && !ex.passport_number && !ex.national_id) return null
    const [id] = await db('profiles').insert({
      full_name: fullName || 'Unknown',
      first_name: ex.first_name || '',
      last_name: ex.last_name || '',
      passport_number: ex.passport_number || null,
      national_id: ex.national_id || null,
      phone_number: ex.phone_number || null,
      date_of_birth: ex.date_of_birth || null,
      gender: ex.sex || ex.gender || null,
      nationality: ex.nationality || 'Ethiopian',
      status: 'active',
      created_by: 'Vision-Auto',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return { id, full_name: fullName }
  } catch (e) {
    console.error('[pipeline] profile upsert failed:', e.message)
    return null
  }
}

// ---------- main pipeline ----------
export async function runPipeline(filePath, db, analyzer, tag = '[pipeline]') {
  const filename = path.basename(filePath)
  const ext = path.extname(filename).toLowerCase()
  if (!ALLOWED_EXTS[ext]) return { ok: false, reason: 'unsupported_ext' }
  const log = (...a) => console.log(tag, ...a)
  const debug = process.env.ADAL_DEBUG_OCR === '1'

  // DEDUPE_MARKER — skip anything already known to the system
  if (db) {
    const fname = path.basename(filePath)
    let fsize = 0
    try { fsize = fs.statSync(filePath).size } catch {}

    // 1. Skip our own generated CVs (by prefix or DB row)
    if (/^AdalCV_/i.test(fname)) {
      console.log(tag, 'skip — generated CV (prefix):', fname)
      return { ok: false, reason: 'generated_cv' }
    }
    try {
      const gen = await db('generated_cvs').where('filename', fname).first()
      if (gen) {
        console.log(tag, 'skip — generated CV (db match):', fname)
        return { ok: false, reason: 'generated_cv' }
      }
    } catch {}

    // 2. Skip files that match a stored file by original_name + size (catches re-downloads)
    try {
      const existing = await db('files')
        .where('original_name', fname)
        .andWhere('size', fsize)
        .first()
      if (existing) {
        console.log(tag, 'skip — already ingested (name+size match):', fname)
        return { ok: false, reason: 'already_ingested' }
      }
    } catch {}

    // 3. Skip files whose name matches a CV template source_file (user re-drops a template)
    try {
      const tpl = await db('cv_templates').where('source_file', fname).first()
      if (tpl) {
        console.log(tag, 'skip — CV template source:', fname)
        return { ok: false, reason: 'cv_template_source' }
      }
    } catch {}
  }

  // Stage the file into SafeStorage
  const stagedName = `${Date.now()}_${filename}`
  const stagedPath = path.join(SAFE_STORAGE_DIR, stagedName)
  fs.copyFileSync(filePath, stagedPath)

  // Build an image for the analyzer (PDFs → first-page PNG)
  let analysisImage = stagedPath
  let analysisMime = ALLOWED_EXTS[ext]
  if (ext === '.pdf') {
    const png = await renderPdfPage(stagedPath, 0, 3)
    if (png) { analysisImage = png; analysisMime = 'image/png' }
  }

  // Analyze
  let result
  try {
    result = await analyzer(analysisImage, filename, analysisMime)
  } catch (e) {
    log('analyzer failed:', e.message)
    if (analysisImage !== stagedPath) try { fs.unlinkSync(analysisImage) } catch {}
    return { ok: false, reason: 'analyzer_failed' }
  } finally {
    if (analysisImage !== stagedPath) try { fs.unlinkSync(analysisImage) } catch {}
  }

  if (debug) console.log(tag + ' vision result:\n' + JSON.stringify(result, null, 2))

  if (!result) {
    log('analyzer returned nothing')
    return { ok: false, reason: 'analyzer_failed' }
  }
  if (result.doc_type === 'other' || result.doc_type === 'Other') {
    log(`skip — classified as other (conf=${result.confidence})`)
    return { ok: false, reason: 'other' }
  }
  if ((result.confidence || 0) < 0.4) {
    log(`skip — low confidence ${result.confidence}`)
    return { ok: false, reason: 'low_confidence', docType: result.doc_type }
  }

  const ex = normalizeNameOrder(result.fields || {})
  ex.phone_number = cleanPhone(ex.phone_number)

  const formats = await ensureBothFormats(stagedPath, ext)
  const fullName = sanitizeName(ex.full_name) ||
                   sanitizeName(`${ex.given_names || ''} ${ex.surname || ''}`) ||
                   nameFromFilename(filename)
  log(`final name: "${fullName}" (doc=${result.doc_type}, conf=${result.confidence})`)

  if (!db) return { ok: false, reason: 'no_db' }
  // Slips must attach to an existing worker profile, matched via reference_name
  let profile
  if (result.doc_type === 'Slip') {
    profile = await findSlipProfile(ex, db)
    if (!profile) {
      log('slip did not match any profile — skipping')
      return { ok: false, reason: 'no_slip_match', docType: 'Slip' }
    }
    console.log(tag, 'slip matched profile #' + profile.id + ' (' + profile.full_name + ')')
    if (ex.order_id) {
      await db('profiles').where('id', profile.id).update({
        order_id: ex.order_id,
        updated_at: new Date().toISOString(),
      })
      console.log(tag, 'order_id "' + ex.order_id + '" stored on profile #' + profile.id)
    }
  } else {
    profile = await getOrCreateProfile(ex, fullName, db)
  }
  if (!profile) {
    log('could not create profile — no name/IDs')
    return { ok: false, reason: 'no_profile' }
  }
  const profileId = profile.id

  // Route to the correct field — doc_type is already the field-template name
  const fieldName = result.doc_type
  let field = await db('profile_fields').where('profile_id', profileId).andWhere('name', fieldName).first()
  if (!field) {
    const tpl = await db('field_templates').where('name', fieldName).first()
    const [fid] = await db('profile_fields').insert({
      profile_id: profileId,
      field_template_id: tpl ? tpl.id : null,
      name: fieldName,
      data_type: 'file',
      is_permanent: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    field = { id: fid }
  }

  for (const f of formats) {
    const st = fs.statSync(f.path)
    await db('files').insert({
      profile_field_id: field.id,
      original_name: f.name,
      path: path.basename(f.path),
      mimetype: f.mimetype,
      size: st.size,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  // PHOTO_CROP_CALL — if passport, crop the headshot and link it to "Photo"
  if (result?.doc_type === 'Passport') {
    const imageEntry = formats.find(f => /image\//.test(f.mimetype))
    const bbox = Array.isArray(ex.photo_bbox) ? ex.photo_bbox : null
    if (imageEntry) {
      try {
        const croppedPath = await cropPassportPhoto(imageEntry.path, bbox)
        if (croppedPath && fs.existsSync(croppedPath)) {
          // ensure a "Photo" field exists for this profile
          let photoField = await db('profile_fields').where('profile_id', profileId).andWhere('name', 'Photo').first()
          if (!photoField) {
            const tpl = await db('field_templates').where('name', 'Photo').first()
            const [fid] = await db('profile_fields').insert({
              profile_id: profileId,
              field_template_id: tpl ? tpl.id : null,
              name: 'Photo',
              data_type: 'file',
              is_permanent: 1,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            photoField = { id: fid }
          }
          const stat = fs.statSync(croppedPath)
          await db('files').insert({
            profile_field_id: photoField.id,
            original_name: path.basename(croppedPath),
            path: path.basename(croppedPath),
            mimetype: 'image/jpeg',
            size: stat.size,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          console.log(tag, 'passport photo cropped → Photo field for profile #' + profileId)
        }
      } catch (e) {
        console.warn(tag, 'photo crop skipped:', e.message)
      }
    }
  }



  const upd = { updated_at: new Date().toISOString() }
  for (const k of ['first_name','middle_name','last_name','date_of_birth','gender','nationality','order_id',
                   'passport_issue_date','passport_expiry_date','place_of_birth',
                   'surname_am','given_names_am','phone_number']) {
    if (ex[k]) upd[k] = ex[k]
  }
  if (ex.sex && !ex.gender) upd.gender = ex.sex
  if (ex.date_of_issue)      upd.passport_issue_date  = ex.date_of_issue
  if (ex.date_of_expiry)     upd.passport_expiry_date = ex.date_of_expiry
  if (fullName && fullName !== 'Unknown') upd.full_name = fullName
  await db('profiles').where('id', profileId).update(upd)

  const [taskId] = await db('tasks').insert({
    type: 'approval',
    title: `${result.doc_type} - ${fullName || 'Unknown'}`,
    document_type: result.doc_type,
    profile_data: JSON.stringify(ex),
    payload: JSON.stringify(ex),
    source_file: path.basename(formats[0].path),
    status: 'done',
    is_ai_created: true,
    profile_id: profileId,
    assigned_to: 1,
    created_at: new Date().toISOString(),
  })
  log(`done — profile #${profileId}, task #${taskId}, ${formats.length} file(s)`)
  return { ok: true, profileId, taskId, docType: result.doc_type, files: formats.length }
}

export function startWatcher(watchDir, db, processorFn, tag = '[pipeline]') {
  if (!fs.existsSync(watchDir)) { console.warn(`${tag} watch dir missing: ${watchDir}`); return }
  const timers = new Map()
  fs.watch(watchDir, (evt, fname) => {
    if (!fname || fname.startsWith('.')) return
    const fp = path.join(watchDir, fname)
    clearTimeout(timers.get(fname))
    timers.set(fname, setTimeout(async () => {
      timers.delete(fname)
      try { const s = await fs.promises.stat(fp); if (s.isFile()) await enqueueFile(db, fp) } catch {}
    }, 3000))
  })
}
