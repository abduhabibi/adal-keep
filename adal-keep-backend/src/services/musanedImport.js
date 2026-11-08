/**
 * "Add from Musaned" (CVs page → 📥 Add from Musaned, run musaned_cv_import):
 * the run has signed in to Musaned in its own tab (a person typed the captcha
 * and the code). Then:
 *
 *   tawtheeq.musaned.com.sa/hr-pool → "Passport Number" filter → her passport
 *   → her row's VIEW link (/hr-pool/candidates/<id>, opened in this tab; on the
 *   page it opens a new tab) → her page asks Musaned for:
 *     api/hrpool/<id>                 her details (birth date, religion …)
 *     api/hrpool/<id>/photo/PASSPORT  her passport
 *     api/hrpool/<id>/photo/PERSONAL  her personal photo
 *   → the passport is read and must be hers → saved on her profile with the
 *   photo (her face cut from the passport when Musaned's "personal photo" is
 *   the passport again) → every empty field filled → her CV made with the
 *   template chosen when the run was started.
 *
 * Nothing on Musaned is changed: it only searches, opens and reads.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const ORIGIN = 'https://tawtheeq.musaned.com.sa'
const HR_POOL = `${ORIGIN}/hr-pool`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TMP = path.join(os.tmpdir(), 'adal-musaned-import')
const SAFE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }

/** A copied file onto her profile field, kept like every upload (data/SafeStorage). False when she has it already. */
export async function saveOnProfile(db, profileId, fieldName, file, original) {
  const buf = fs.readFileSync(file)
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const now = new Date().toISOString()
  let field = await db('profile_fields').where({ profile_id: profileId, name: fieldName }).first()
  if (!field) {
    const tpl = await db('field_templates').where('name', fieldName).first().catch(() => null)
    const [id] = await db('profile_fields').insert({ profile_id: profileId, field_template_id: tpl?.id || null, name: fieldName, data_type: 'file', is_permanent: 1, created_at: now, updated_at: now })
    field = { id }
  }
  if (await db('files').where({ profile_field_id: field.id, content_hash: hash }).first()) return false
  fs.mkdirSync(SAFE, { recursive: true })
  const stored = `${Date.now()}_${original.replace(/[^\w.\-]+/g, '_')}`
  fs.writeFileSync(path.join(SAFE, stored), buf)
  await db('files').insert({ profile_field_id: field.id, original_name: original, path: stored, mimetype: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', size: buf.length, content_hash: hash, created_at: now, updated_at: now })
  return true
}

/** HR Pool → Passport Number filter → her row's VIEW address, or null when she is not in the list. */
async function searchPassport(page, passport, log) {
  await page.goto(HR_POOL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await page.waitForFunction(() => [...document.querySelectorAll('app-filter-search')].some(f => /Passport Number/i.test(f.textContent || '')), { timeout: 30000 })
  const filter = (await page.evaluateHandle(() => [...document.querySelectorAll('app-filter-search')].find(f => /Passport Number/i.test(f.textContent || '')))).asElement()
  await filter.evaluate(f => f.querySelector('button.app-filter-header, .app-filter-header')?.click())
  await sleep(700)
  const input = await filter.$('textarea, input')
  if (!input) throw new Error('Musaned: the passport search box did not open')
  await input.evaluate(i => { i.focus(); i.value = '' })
  await input.type(passport, { delay: 40 })
  await input.press('Enter')
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {})
  await sleep(1200)
  log(`🔎 HR Pool → passport ${passport}`)
}

async function findHerPage(page, passport, log) {
  await searchPassport(page, passport, log)
  // Her row: the smallest box with her passport and a VIEW link.
  const href = await page.evaluate((pp) => {
    const views = [...document.querySelectorAll('a, button')].filter(b => /^\s*(VIEW|DETAILS|عرض|التفاصيل)\s*$/i.test(b.innerText || ''))
    for (const b of views) {
      let c = b
      for (let i = 0; i < 8 && c && !(c.innerText || '').toUpperCase().includes(pp); i++) c = c.parentElement
      if (c && (c.innerText || '').toUpperCase().includes(pp)) return b.getAttribute('href') || b.closest('a')?.getAttribute('href') || ''
    }
    return null
  }, passport.toUpperCase())
  if (href === null) return null
  if (!href) throw new Error('Musaned: her VIEW has no address')
  return new URL(href, ORIGIN).href
}

/** The rows showing exactly this passport number, and whether each has Delete. */
const herRows = (page, passport) => page.evaluate((pp) => [...document.querySelectorAll('tr')]
  .filter(r => [...r.querySelectorAll('.app-table-value, td')].some(c => (c.innerText || '').trim().toUpperCase() === pp))
  .map(r => ({ canDelete: !!r.querySelector('button.candidate-delete:not([disabled])') })), passport)

/**
 * "Delete from Musaned" (run musaned_delete): signed in → HR Pool → her passport
 * → Delete on her row, and Musaned's question answered. Only a row with exactly
 * her number, and only when it is the one row; the search is run again after,
 * so "deleted" is what Musaned shows. Her profile here stays.
 */
export async function deleteFromHrPoolInRun(page, ctx) {
  const log = (m, level = 'info') => ctx.onLog?.(level, m)
  const passport = String(ctx.profile?.passport_number || '').trim().toUpperCase()
  if (!passport) return { ok: false, error: 'Profile is missing the passport number' }

  await searchPassport(page, passport, log)
  const rows = await herRows(page, passport)
  if (!rows.length) {
    log(`ℹ️ passport ${passport} is not in the HR Pool: nothing to delete`)
    await ctx.notify?.(`ℹ️ ${ctx.profileName}: not available on Musaned`, `Passport ${passport} is not in the HR Pool. Nothing was deleted.`)
    await ctx.noteProfile?.(`Musaned: passport ${passport} is not in the HR Pool (nothing deleted)`, { musaned_stage: null })
    return { ok: true, done: true, note: 'not available' }
  }
  if (rows.length > 1) return { ok: false, error: `Musaned shows ${rows.length} rows for passport ${passport}: delete the right one by hand` }
  if (!rows[0].canDelete) return { ok: false, error: 'Musaned has no Delete for her (she may have a contract or a request)' }

  // Its question may be the browser's own or a box on the page.
  const yes = (d) => d.accept().catch(() => {})
  page.on('dialog', yes)
  try {
    await page.evaluate((pp) => {
      const row = [...document.querySelectorAll('tr')].find(r => [...r.querySelectorAll('.app-table-value, td')].some(c => (c.innerText || '').trim().toUpperCase() === pp))
      row.querySelector('button.candidate-delete').click()
    }, passport)
    log('🗑 pressed Delete')
    let answered = false
    for (let i = 0; i < 16 && !answered; i++) {
      await sleep(500)
      answered = await page.evaluate(() => {
        const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const box = [...document.querySelectorAll('.modal.show, [role="dialog"], [role="alertdialog"], .swal2-popup, .p-dialog, .p-confirm-dialog, ngb-modal-window')].find(seen)
        const b = box && [...box.querySelectorAll('button, a.btn')].filter(seen).find(e => /^\s*(yes|ok|confirm|delete|نعم|موافق|تأكيد|حذف)\s*$/i.test(e.innerText || ''))
        b?.click()
        return !!b
      }).catch(() => false)
    }
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {})
    await sleep(1000)
  } finally { page.off('dialog', yes) }

  await searchPassport(page, passport, log)
  if ((await herRows(page, passport)).length) {
    // Its question looked different, or it refused: a person sees why.
    await ctx.notify?.(`🖐 ${ctx.profileName}: Musaned did not delete her`, 'Open the tab to see why, or press Delete there.', 'warn', { confirm: true })
    return { ok: false, error: 'Musaned still shows her after Delete' }
  }
  log(`✓ passport ${passport} deleted from the HR Pool`)
  await ctx.notify?.(`✅ ${ctx.profileName}: deleted from Musaned`, `Passport ${passport} is no longer in the HR Pool.`)
  await ctx.noteProfile?.(`Musaned: deleted from the HR Pool (passport ${passport})`, { musaned_stage: null })
  return { ok: true, done: true }
}

/** Musaned's details → Adal Keep's fields (only clear values). */
export function fieldsFromMusaned(d = {}) {
  const day = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : ''
  const religion = String(d.religion || '')
  const marital = String(d.maritalStatus || '')
  const kin = String(d.relativeContactKinship || '')
  const edu = (d.qualifications || []).map(q => q?.nameEn || q?.value || q?.name || '').filter(Boolean)[0] || ''
  return {
    full_name: String(d.name || '').trim(),
    date_of_birth: day(d.dateOfBirthGregorian),
    gender: /^f/i.test(d.gender || '') ? 'F' : /^m/i.test(d.gender || '') ? 'M' : '',
    marital_status: /single/i.test(marital) ? 'SINGLE' : /married/i.test(marital) ? 'MARRIED' : /divorc/i.test(marital) ? 'DIVORCED' : /widow/i.test(marital) ? 'WIDOWED' : '',
    religion: /^non/i.test(religion) ? 'Non Muslim' : /muslim|islam/i.test(religion) ? 'Muslim' : /christ|orthodox/i.test(religion) ? 'Orthodox' : '',
    phone_number: String(d.mobileNumber || '').trim(),
    passport_issue_date: day(d.passportIssueDateGregorian),
    passport_expiry_date: day(d.passportExpireDateGregorian),
    children_count: Number.isFinite(Number(d.amountOfChildren)) ? String(Number(d.amountOfChildren)) : '',
    education_level: String(edu).trim(),
    emergency_name: String(d.relativeContactName || '').trim(),
    emergency_phone: String(d.relativeContactPhone || '').trim(),
    emergency_relationship: kin.trim(),
  }
}

/** The run's work after the Musaned sign-in. Returns the worker's result. */
export async function importFromHrPoolInRun(page, ctx) {
  const db = ctx.db
  const log = (m, level = 'info') => ctx.onLog?.(level, m)
  const p = await db('profiles').where('id', ctx.profileId).first()
  const passport = String(p?.passport_number || '').trim().toUpperCase()
  if (!passport) return { ok: false, error: 'Profile is missing the passport number' }
  page.__adalAllowImages = true // her pictures are what this run is for

  const url = await findHerPage(page, passport, log)
  if (!url) {
    const msg = `Passport ${passport} is not in our Musaned HR Pool list`
    log(msg, 'error')
    await ctx.notify?.(`❌ ${ctx.profileName}: not found on Musaned`, msg)
    return { ok: false, error: msg }
  }

  // Her page, in this tab: catch what it asks Musaned for.
  const got = { passport: null, personal: null, details: null }
  const id = url.split('/').pop()
  const onResponse = async (r) => {
    const u = r.url().replace(/[?#].*/, '')
    if (!u.includes(`/hrpool/${id}`)) return
    try {
      if (/\/photo\/PASSPORT$/i.test(u)) got.passport = { buf: await r.buffer(), type: r.headers()['content-type'] || '' }
      else if (/\/photo\/PERSONAL$/i.test(u)) got.personal = { buf: await r.buffer(), type: r.headers()['content-type'] || '' }
      else if (u.endsWith(`/hrpool/${id}`)) got.details = await r.json()
    } catch {}
  }
  page.on('response', onResponse)
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
    for (let i = 0; i < 30 && !(got.details && got.passport && got.personal); i++) await sleep(500)
    // Not caught (Musaned changed its addresses): the page's own pictures.
    if (!got.passport && !got.personal) {
      const blobs = await page.evaluate(async () => Promise.all([...document.querySelectorAll('img[src^="blob:"]')].map(async i => {
        const buf = new Uint8Array(await (await fetch(i.src)).arrayBuffer()); let s = ''
        for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000))
        return btoa(s)
      }))).catch(() => [])
      const bufs = blobs.map(b => Buffer.from(b, 'base64'))
      if (bufs[0]) got.personal = { buf: bufs[0], type: 'image/jpeg' }
      if (bufs[1]) got.passport = { buf: bufs[1], type: 'image/jpeg' }
    }
  } finally { page.off('response', onResponse) }

  const shown = got.details?.passportNumber || ''
  if (shown && String(shown).toUpperCase() !== passport) {
    const msg = `Musaned opened passport ${shown}, not ${passport} — nothing copied`
    log(msg, 'error')
    return { ok: false, error: msg }
  }
  log(`📄 her Musaned page: ${[got.details && 'details', got.passport && 'passport', got.personal && 'personal photo'].filter(Boolean).join(', ') || 'nothing'}`)
  if (!got.passport && !got.personal && !got.details) {
    const msg = 'Her Musaned page showed no passport, photo or details to copy'
    await ctx.notify?.(`⚠️ ${ctx.profileName}: nothing to copy`, msg)
    return { ok: false, error: msg }
  }
  return applyMusanedFiles(ctx, got)
}

const extOf = (buf, type) => buf.subarray(0, 4).toString() === '%PDF' ? '.pdf'
  : buf[0] === 0x89 ? '.png' : /webp/.test(type || '') ? '.webp' : '.jpg'

/**
 * What came from her Musaned page → her profile.
 * got: { passport: {buf,type}, personal: {buf,type}, details: {...} } (any may be missing).
 */
export async function applyMusanedFiles(ctx, got) {
  const db = ctx.db
  const log = (m, level = 'info') => ctx.onLog?.(level, m)
  const p = await db('profiles').where('id', ctx.profileId).first()
  const passport = String(p?.passport_number || '').trim().toUpperCase()
  fs.mkdirSync(TMP, { recursive: true })
  const tmp = (name) => path.join(TMP, `${ctx.runId}-${name}`)
  const { analyzeWithMineru } = await import('./mineruClassifier.js')

  // 1. The passport: read, and it must be hers.
  let passportFile = null, passportRead = null
  if (got.passport?.buf?.length) {
    passportFile = tmp(`passport${extOf(got.passport.buf, got.passport.type)}`)
    fs.writeFileSync(passportFile, got.passport.buf)
    try { passportRead = await analyzeWithMineru(passportFile, { db }) } catch (e) { log(`passport not read: ${e.message}`, 'warn') }
    const pp = String(passportRead?.fields?.passport_number || '').toUpperCase()
    if (pp && pp !== passport) {
      log(`Musaned's passport picture is passport ${pp}, not ${passport} — not used`, 'error')
      passportFile = null; passportRead = null
    }
  }

  // 2. The photo: Musaned's personal photo — unless it is the passport again
  //    (or a passport at all); then her face cut from the passport.
  let photoFile = null
  if (got.personal?.buf?.length) {
    const same = got.passport?.buf && Buffer.compare(got.personal.buf, got.passport.buf) === 0
    if (!same) {
      const f = tmp(`personal${extOf(got.personal.buf, got.personal.type)}`)
      fs.writeFileSync(f, got.personal.buf)
      let r = null
      try { r = await analyzeWithMineru(f, { db }) } catch {}
      if (r?.doc_type === 'Passport' || r?.fields?.passport_number) log('Musaned\'s "personal photo" is a passport — her face is cut from the passport instead', 'warn')
      else photoFile = f
    } else log('Musaned\'s "personal photo" is her passport again — her face is cut from the passport')
  }
  let faceCut = false
  if (!photoFile && passportFile) {
    try {
      const { faceFromPassport } = await import('./passportFace.js')
      photoFile = await faceFromPassport(passportFile, tmp('face_photo.jpg'))
      faceCut = !!photoFile
    } catch (e) { log(`face not cut: ${e.message}`, 'warn') }
  }

  const saved = []
  if (passportFile && await saveOnProfile(db, p.id, 'Passport', passportFile, `Passport_${passport}${path.extname(passportFile)}`)) saved.push('passport')
  // "…_photo.jpg" = a face cut from the passport (Musaned's own run still asks for a real photo).
  if (photoFile && await saveOnProfile(db, p.id, 'Photo', photoFile, faceCut ? `Passport_${passport}_photo.jpg` : `Photo_${passport}${path.extname(photoFile)}`)) saved.push(faceCut ? 'photo (face from the passport)' : 'photo')
  if (saved.length) log(`✓ saved on her profile: ${saved.join(' and ')}`)

  // 3. Every empty field: Musaned's details first, then the passport's reading.
  const f = passportRead?.fields || {}
  const fromPassport = {
    full_name: f.full_name || [f.given_names, f.surname].filter(Boolean).join(' '),
    date_of_birth: f.date_of_birth, gender: f.sex || f.gender, place_of_birth: f.place_of_birth,
    passport_issue_date: f.date_of_issue || f.passport_issue_date,
    passport_expiry_date: f.date_of_expiry || f.passport_expiry_date, nationality: f.nationality,
  }
  const fromMusaned = fieldsFromMusaned(got.details || {})
  const now = await db('profiles').where('id', p.id).first()
  const cols = new Set(Object.keys(now))
  const upd = {}
  for (const src of [fromMusaned, fromPassport]) {
    for (const [k, v] of Object.entries(src)) {
      if (cols.has(k) && v && !upd[k] && !String(now[k] ?? '').trim()) upd[k] = String(v).trim()
    }
  }
  if (Object.keys(upd).length) {
    await db('profiles').where('id', p.id).update({ ...upd, updated_at: new Date().toISOString() })
    log(`✓ filled: ${Object.keys(upd).join(', ')}`)
  }
  if (saved.includes('passport')) {
    try { const { runPassportVerification } = await import('./verification.js'); await runPassportVerification(p.id, { handle: db }) } catch {}
    try { const { fillPassportDetails } = await import('./passportDetails.js'); await fillPassportDetails(db, p.id, passportFile, (m) => log(m)) } catch {}
  }

  // 4. Her CV with the chosen template.
  let cvNote = ''
  const templateId = Number(ctx.cv_template_id) || (await db('cv_templates').where('is_active', 1).orderBy('id').first('id'))?.id
  if (templateId) {
    try {
      const t = await db('cv_templates').where('id', templateId).first()
      const { generateCvFile } = await import('../routes/cv.js')
      const made = await generateCvFile(db, await db('profiles').where('id', p.id).first(), t, {}, 'musaned')
      cvNote = ` · CV made (${t.name})`
      log(`✓ CV made with ${t.name}: ${made.original_name}`)
    } catch (e) { log(`CV not made: ${e.message}`, 'warn'); cvNote = ' · CV not made' }
  }
  for (const n of fs.readdirSync(TMP)) if (n.startsWith(`${ctx.runId}-`)) fs.rmSync(path.join(TMP, n), { force: true })

  const note = `From Musaned: ${saved.join(' + ') || 'no new file'}${Object.keys(upd).length ? ` · ${Object.keys(upd).length} field(s) filled` : ''}${cvNote}`
  await ctx.notify?.(`📥 ${ctx.profileName}: added from Musaned`, note)
  return { ok: true, done: true, note }
}
