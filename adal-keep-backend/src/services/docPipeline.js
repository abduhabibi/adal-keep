import fs from 'fs'
import { enqueueFile, setStage } from './ingestQueue.js'
import { getActiveEmployee } from './activeEmployee.js'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import imageToPdf from 'image-to-pdf'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')
if (!fs.existsSync(SAFE_STORAGE_DIR)) fs.mkdirSync(SAFE_STORAGE_DIR, { recursive: true })

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
  // imageToPdf cannot read WebP: convert to PNG first and build the twin from it.
  if (ext === '.webp') {
    const pngPath = path.join(dir, `${base}.png`)
    await sharp(originalPath).png().toFile(pngPath)
    fs.unlinkSync(originalPath)
    return ensureBothFormats(pngPath, '.png')
  }
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
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

/**
 * The profile a document belongs to: same passport number, same ID number,
 * or exactly the same name. Only an existing profile — see createProfile.
 */
async function findProfile(ex, names, db) {
  let p = null
  if (ex.passport_number) p = await db('profiles').where('passport_number', ex.passport_number).first()
  if (!p && ex.national_id) p = await db('profiles').where('national_id', ex.national_id).first()
  for (const n of names) {
    if (p || !n || n.split(' ').length < 2) continue // one word matches too many people
    p = await db('profiles').where('full_name', n).first()
  }
  return p || null
}

/**
 * A new profile — only from a passport whose MRZ check digits verified, so
 * the name and number on it are the ones printed in the passport.
 */
async function createProfile(ex, fullName, db) {
  try {
    if (!fullName || !ex.passport_number) return null
    // Attribute the new profile to the employee currently bound to this machine
    let createdBy = 'Vision-Auto'
    try {
      const active = await getActiveEmployee(db)
      if (active?.name) createdBy = active.name
    } catch {}
    const [id] = await db('profiles').insert({
      full_name: fullName,
      first_name: ex.first_name || '',
      last_name: ex.last_name || '',
      passport_number: ex.passport_number || null,
      national_id: ex.national_id || null,
      phone_number: ex.phone_number || null,
      date_of_birth: ex.date_of_birth || null,
      gender: ex.sex || ex.gender || null,
      nationality: ex.nationality || 'Ethiopian',
      status: 'active',
      created_by: createdBy,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return { id, full_name: fullName }
  } catch (e) {
    console.error('[pipeline] profile create failed:', e.message)
    return null
  }
}

// ---------- main pipeline ----------
/**
 * Put an unreadable passport on the Notifications page, so the operator sees
 * it and re-uploads a clear copy. The file itself is not stored.
 */
export async function notifyPassportUnreadable(db, filename, reason) {
  const now = new Date().toISOString()
  await db('notifications').insert({
    company_id: 1,
    type: 'passport_unreadable',
    title: `Passport not readable: ${filename}`,
    body: `${reason} Re-upload a clear, straight-on photo of the passport data page with both MRZ lines fully visible.`,
    created_day: now.slice(0, 10),
    created_at: now,
    updated_at: now,
  })
}

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
        .whereNotNull('profile_field_id')   // a tray copy is not read yet
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

  // Read-only analysis on the source file. Nothing is copied into storage
  // until the document is accepted, so ignored files leave no trace on disk.
  const contentHash = sha256File(filePath)

  setStage('reading the document')
  let result
  try {
    result = await analyzer(filePath, filename, ALLOWED_EXTS[ext], filePath)
  } catch (e) {
    log('analyzer failed:', e.message)
    return { ok: false, reason: 'analyzer_failed' }
  }

  if (debug) console.log(tag + ' vision result:\n' + JSON.stringify(result, null, 2))

  if (result.doc_type === 'Passport' && (result.confidence || 0) < 0.9) {
    log(`passport unreadable — MRZ not verified (conf=${result.confidence})`)
    await notifyPassportUnreadable(db, filename, 'The MRZ check digits did not verify, so the passport data cannot be trusted.')
    return { ok: false, reason: 'passport_unreadable' }
  }

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
  // A CV, visa or contract: every detail on it (JEV points, this PC reads,
  // JEV picks the choices). It only adds what the reading above did not have.
  try {
    const { DETAIL_TYPES, readDocumentDetails } = await import('./docDetails.js')
    if (DETAIL_TYPES.has(result.doc_type)) {
      setStage(`reading every detail of the ${result.doc_type}`)
      const more = await readDocumentDetails(filePath, result.doc_type, log)
      for (const [k, v] of Object.entries(more)) if (v && !ex[k]) ex[k] = v
      if (more.full_name && !result.fields?.full_name) normalizeNameOrder(ex)
    }
  } catch (e) { log('details:', e.message) }
  ex.phone_number = cleanPhone(ex.phone_number)

  // The name printed in the document. The file's own name ("IMG-2026…",
  // "WhatsApp Image…") is never a person's name: it only helps find a profile.
  const fullName = sanitizeName(ex.full_name) ||
                   sanitizeName(`${ex.given_names || ''} ${ex.surname || ''}`)
  // Only a passport (its MRZ verified — checked above) names or creates a profile.
  const isPassport = result.doc_type === 'Passport'
  // Another agency's CV ("APPLICATION FOR EMPLOYMENT") is how most girls'
  // passport details arrive: with its passport number and name it makes her
  // profile too (kept as her CV; her passport is still asked for).
  const passportNo = String(ex.passport_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (passportNo) ex.passport_number = passportNo
  const cvWithPassport = result.doc_type === 'CV' && /^[A-Z]{1,2}\d{6,9}$/.test(passportNo) && fullName.split(' ').length >= 2
  log(`name in the document: "${fullName}" (doc=${result.doc_type}, conf=${result.confidence})`)

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
    profile = await findProfile(ex, [fullName, nameFromFilename(filename)], db)
    if (!profile && (isPassport || cvWithPassport)) { profile = await createProfile(ex, fullName, db); if (profile) profile.created = true }
  }
  if (!profile) {
    if (isPassport) {
      log('could not create profile — no name/passport number')
      await notifyPassportUnreadable(db, filename, 'No name could be read from it.')
      return { ok: false, reason: 'no_profile' }
    }
    // Not a passport and no profile it belongs to: leave it alone. New
    // profiles come from passports only, so names are never guessed.
    log(`skip — ${result.doc_type} matches no profile (profiles are created from passports only)`)
    return { ok: false, reason: 'no_profile_match', docType: result.doc_type }
  }
  const profileId = profile.id

  setStage(`saving it to ${profile.full_name || 'the profile'}`)
  // Route to the correct field — doc_type is already the field-template name
  const fieldName = result.doc_type
  let field = await db('profile_fields').where('profile_id', profileId).andWhere('name', fieldName).first()

  // One copy per profile + field: a file whose exact content is already in
  // this field is not stored again.
  if (field) {
    const dup = await db('files')
      .where('profile_field_id', field.id)
      .andWhere('content_hash', contentHash)
      .first()
    if (dup) {
      log(`skip — duplicate of file #${dup.id} already in ${fieldName} (profile #${profileId})`)
      return { ok: false, reason: 'duplicate_in_field', profileId, docType: fieldName }
    }
    // Same person, different scan: a passport with the same number as the one
    // already on this profile is the same document, not a new one.
    const newNumber = String(ex.passport_number || '').trim().toUpperCase()
    if (fieldName === 'Passport' && newNumber) {
      const prof = await db('profiles').where('id', profileId).first()
      const onFileVerified = prof?.verified_at || Number(prof?.passport_ticks || 0) >= 3
      if (onFileVerified && String(prof?.passport_number || '').trim().toUpperCase() === newNumber) {
        log(`skip — passport ${newNumber} already on profile #${profileId}`)
        return { ok: false, reason: 'duplicate_in_field', profileId, docType: fieldName }
      }
    }
  }

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

  // Accepted: stage the original into SafeStorage. Documents keep their twin
  // (image -> PDF, PDF -> PNG page 1). Photos store only the image itself.
  const stagedName = `${Date.now()}_${filename}`
  const stagedPath = path.join(SAFE_STORAGE_DIR, stagedName)
  fs.copyFileSync(filePath, stagedPath)
  const formats = result.doc_type === 'Photo'
    ? [{ path: stagedPath, mimetype: ALLOWED_EXTS[ext], name: filename }]
    : await ensureBothFormats(stagedPath, ext)
  for (const f of formats) {
    await db('files').insert({
      profile_field_id: field.id,
      original_name: f.name,
      path: path.basename(f.path),
      mimetype: f.mimetype,
      size: fs.statSync(f.path).size,
      content_hash: contentHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  // The Companion's unread copy of this same download in the tray goes: it is
  // filed now (only a copy of the last hour, same name and size).
  try {
    const origSize = fs.statSync(filePath).size
    const trayCopies = await db('files').whereNull('profile_field_id')
      .where('original_name', filename).andWhere('size', origSize)
      .andWhere('created_at', '>=', new Date(Date.now() - 3600000).toISOString())
    for (const t of trayCopies) {
      await db('files').where('id', t.id).del()
      try { const { resolveStoredPath } = await import('./cvRender.js'); const p = resolveStoredPath(t.path); if (p) fs.unlinkSync(p) } catch {}
    }
    if (trayCopies.length) log(`its copy in the tray (${trayCopies.length}) is filed now`)
  } catch {}

  // A verified passport sets the details. Any other document only fills
  // what the profile does not have yet — it never renames anyone.
  const read = {}
  for (const k of ['first_name','middle_name','last_name','date_of_birth','gender','nationality','order_id',
                   'passport_issue_date','passport_expiry_date','place_of_birth',
                   'surname_am','given_names_am','phone_number',
                   // what a CV, visa or contract tells (docDetails.js)
                   'religion','marital_status','children_count','height','weight','education_level','living_town',
                   'job_title','salary','experience_years','work_experience','experience_country','speaks_arabic',
                   'speaks_english','cooking_skill','emergency_name','emergency_phone','mother_name','father_name',
                   'spouse_name','labor_id','visa_number','visa_application_number','employer_name','employer_id',
                   'employer_phone','employer_address','work_city','destination_country','contract_number','contract_date']) {
    if (ex[k]) read[k] = ex[k]
  }
  if (ex.sex && !ex.gender) read.gender = ex.sex
  if (ex.date_of_issue)      read.passport_issue_date  = ex.date_of_issue
  if (ex.date_of_expiry)     read.passport_expiry_date = ex.date_of_expiry
  if (isPassport && fullName) read.full_name = fullName
  const current = await db('profiles').where('id', profileId).first()
  const upd = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries(read)) {
    if (k in (current || {}) && (isPassport || !current[k])) upd[k] = v
  }
  await db('profiles').where('id', profileId).update(upd)

  // Place of birth and issue date are not in the passport's machine lines: when
  // the passport was settled from those alone, read them now (in the background).
  if (isPassport && (!(upd.place_of_birth || current?.place_of_birth) || !(upd.passport_issue_date || current?.passport_issue_date))) {
    const img = formats.find(f => /^image\//.test(f.mimetype || ''))?.path || stagedPath
    import('./passportDetails.js').then(m => m.fillPassportDetails(db, profileId, img, log)).catch(e => log('passport details:', e.message))
  }

  // A passport is checked against its MRZ right away, so the police-clearance
  // gate is already lit when the document arrives (no manual Re-check needed).
  if (result.doc_type === 'Passport') {
    try {
      const { runPassportVerification } = await import('./verification.js')
      const v = await runPassportVerification(profileId, { handle: db, markdown: result.markdown || null })
      log(`passport checks: ${v.ticks_count}/3 green`)
    } catch (e) {
      log('passport check failed:', e.message)
    }
  }

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
  log(`done — profile #${profileId}, task #${taskId}, stored ${formats.length} file(s)`)
  return { ok: true, profileId, taskId, docType: result.doc_type, files: formats.length, created: !!profile.created }
}

// When Adal Keep last watched (saved every 30 s): at start-up, what arrived
// in the folders since then — while it was closed or restarting — is read too.
const ALIVE_FILE = path.join(SAFE_STORAGE_DIR, '..', 'watcher-alive.json')
const BOOT_AT = Date.now()
function lastAlive() {
  try { return Number(JSON.parse(fs.readFileSync(ALIVE_FILE, 'utf8')).at) || 0 } catch { return 0 }
}
const LAST_ALIVE = lastAlive()
setInterval(() => { try { fs.writeFileSync(ALIVE_FILE, JSON.stringify({ at: Date.now() })) } catch {} }, 30000).unref?.()

/** Every file in the folder that arrived since `since` goes to the queue (it skips what it has seen). */
async function sweepFolder(watchDir, db, since) {
  let names = []
  try { names = await fs.promises.readdir(watchDir) } catch { return 0 }
  let n = 0
  for (const name of names) {
    if (name.startsWith('.') || !ALLOWED_EXTS[path.extname(name).toLowerCase()]) continue
    const fp = path.join(watchDir, name)
    try {
      const st = await fs.promises.stat(fp)
      if (!st.isFile() || Math.max(st.birthtimeMs || 0, st.ctimeMs || 0) < since) continue
      if (Date.now() - st.mtimeMs < 3000) continue   // still being written: next round
      const before = await db('ingest_queue').count('* as c').first()
      await enqueueFile(db, fp, { since })
      const after = await db('ingest_queue').count('* as c').first()
      if (Number(after.c) > Number(before.c)) n++
    } catch {}
  }
  return n
}

export function startWatcher(watchDir, db, processorFn, tag = '[pipeline]') {
  if (!fs.existsSync(watchDir)) {
    // e.g. Telegram's folder before its first download: look again later.
    console.warn(`${tag} watch dir missing (checking again every minute): ${watchDir}`)
    const t = setInterval(() => {
      if (fs.existsSync(watchDir)) { clearInterval(t); startWatcher(watchDir, db, processorFn, tag) }
    }, 60000)
    t.unref?.()
    return
  }
  console.log(`${tag} watching ${watchDir}`)
  // Windows sometimes says nothing about a new file (many at once, a file
  // moved in, a restart): the folder is also looked at every 30 seconds, and
  // at start-up for everything since Adal Keep last watched (at most a day).
  if (!startWatcher.swept) startWatcher.swept = new Set()
  if (!startWatcher.swept.has(watchDir)) {
    startWatcher.swept.add(watchDir)
    const bootSince = Math.max(LAST_ALIVE ? LAST_ALIVE - 60000 : BOOT_AT - 10 * 60000, Date.now() - 24 * 3600000)
    setTimeout(() => sweepFolder(watchDir, db, bootSince)
      .then(n => { if (n) console.log(`${tag} ${n} file(s) that came while Adal Keep was closed: reading them`) }).catch(() => {}), 5000).unref?.()
    setInterval(() => sweepFolder(watchDir, db, Date.now() - 10 * 60000)
      .then(n => { if (n) console.log(`${tag} ${n} file(s) Windows did not report: reading them`) }).catch(() => {}), 30000).unref?.()
  }
  const timers = new Map()
  const watcher = fs.watch(watchDir, (evt, fname) => {
    if (!fname || fname.startsWith('.')) return
    const fp = path.join(watchDir, fname)
    clearTimeout(timers.get(fname))
    timers.set(fname, setTimeout(async () => {
      timers.delete(fname)
      try { const s = await fs.promises.stat(fp); if (s.isFile()) await enqueueFile(db, fp) } catch {}
    }, 2000)) // 2 s without a change: the download or copy has finished
  })
  // The folder went away (a USB, a moved Downloads): wait for it, do not crash.
  watcher.on('error', (e) => {
    console.warn(`${tag} lost ${watchDir}: ${e.message}`)
    watcher.close()
    setTimeout(() => startWatcher(watchDir, db, processorFn, tag), 5000).unref?.()
  })
}
