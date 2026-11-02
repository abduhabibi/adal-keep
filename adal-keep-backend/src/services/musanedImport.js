/**
 * "Add from Musaned" (CVs page → 📥 Add from Musaned, run musaned_cv_import):
 * the run has signed in to Musaned in its own tab (a person typed the captcha
 * and the code). Then:
 *
 *   tawtheeq.musaned.com.sa/hr-pool → "Passport Number" filter → her passport
 *   → her row's VIEW / Details → her page: every picture and PDF Musaned loads
 *   there is caught → each one is read → the passport and the personal photo
 *   go onto her profile, every empty field is filled from the passport (and
 *   from Musaned's own page: religion, marital status …) → her CV is made with
 *   the template chosen when the run was started.
 *
 * Nothing on Musaned is changed: it only searches, opens and reads.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const HR_POOL = 'https://tawtheeq.musaned.com.sa/hr-pool'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TMP = path.join(os.tmpdir(), 'adal-musaned-import')
const SAFE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' }

/** A copied file onto her profile field, kept like every upload (data/SafeStorage). False when she has it already. */
async function saveOnProfile(db, profileId, fieldName, file, original) {
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

/** HR Pool → Passport Number filter → her row. Returns false when she is not in the list. */
async function openHerRow(page, passport, log) {
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
  // Her row: the smallest box with her passport and a VIEW / Details button.
  return page.evaluate((pp) => {
    const buttons = [...document.querySelectorAll('button, a')].filter(b => /^\s*(VIEW|DETAILS|View|Details|عرض|التفاصيل)\s*$/i.test(b.innerText || ''))
    for (const b of buttons) {
      let c = b
      for (let i = 0; i < 8 && c && !(c.innerText || '').toUpperCase().includes(pp); i++) c = c.parentElement
      if (c && (c.innerText || '').toUpperCase().includes(pp)) { b.scrollIntoView({ block: 'center' }); b.click(); return true }
    }
    return false
  }, passport.toUpperCase())
}

/** Label → value pairs on her page (Musaned shows "Label" above or beside its value). */
function readPairs(page) {
  return page.evaluate(() => {
    const pairs = {}
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    for (const el of document.querySelectorAll('label, dt, th, .label, [class*="label"], [class*="title"], span, p, div')) {
      if (el.children.length > 2) continue
      const k = clean(el.innerText).replace(/[:：]$/, '')
      if (!k || k.length > 40 || /\d{4}/.test(k)) continue
      const next = el.nextElementSibling || el.parentElement?.nextElementSibling
      const v = clean(next?.innerText)
      if (v && v.length < 80 && v !== k && !pairs[k]) pairs[k] = v
    }
    return pairs
  })
}
const pick = (pairs, ...labels) => {
  for (const l of labels) {
    const k = Object.keys(pairs).find(x => x.toLowerCase() === l.toLowerCase())
    if (k && pairs[k] && pairs[k] !== '-') return pairs[k]
  }
  return ''
}

/**
 * Every picture / PDF Musaned sends while her page is open, plus the ones its
 * file viewer opens (a "Passport" / "Photo" link opens a viewer tab with the
 * file as a blob). Returns [{ buf, type }].
 */
function catchFiles(page) {
  const got = []
  const seen = new Set()
  const keep = (buf, type) => {
    if (!buf || buf.length < 15000) return // icons, logos
    const key = `${buf.length}:${buf.subarray(0, 64).toString('hex')}`
    if (seen.has(key)) return
    seen.add(key); got.push({ buf, type })
  }
  const onResponse = async (r) => {
    const type = String(r.headers()['content-type'] || '')
    if (!/^image\/(jpe?g|png|webp)|application\/pdf|application\/octet-stream/i.test(type)) return
    if (/\/assets\/|logo|icon|sprite|avatar-placeholder/i.test(r.url())) return
    try { keep(await r.buffer(), type) } catch {}
  }
  page.on('response', onResponse)
  return { got, keep, stop: () => page.off('response', onResponse) }
}

/** Opens each file link on her page that looks like the passport or the photo, and keeps what its viewer shows. */
async function openFileLinks(page, keep, log) {
  const browser = page.browser()
  const names = await page.evaluate(() => [...document.querySelectorAll('a, button, span')]
    .map(x => (x.textContent || '').trim())
    .filter(t => t && t.length < 80 && /passport|photo|picture|جواز|صورة|\.(jpe?g|png|pdf)$/i.test(t)))
  for (const name of [...new Set(names)].slice(0, 6)) {
    const viewer = new Promise(resolve => {
      const on = (t) => { if (t.opener() === page.target() || /file-viewer|blob:/.test(t.url())) { browser.off('targetcreated', on); resolve(t) } }
      browser.on('targetcreated', on)
      setTimeout(() => { browser.off('targetcreated', on); resolve(null) }, 12000)
    })
    const clicked = await page.evaluate((name) => {
      const a = [...document.querySelectorAll('a, button, span')].find(x => (x.textContent || '').trim() === name)
      if (!a) return false
      a.scrollIntoView({ block: 'center' }); a.click(); return true
    }, name)
    if (!clicked) continue
    const t = await viewer
    if (!t) { await sleep(1500); continue } // shown on the page itself: the response catcher has it
    const v = await t.page().catch(() => null)
    try {
      if (!v) continue
      await v.waitForFunction(() => /^blob:|^data:|^https?:/.test(document.querySelector('iframe, embed, img')?.src || ''), { timeout: 30000, polling: 300 }).catch(() => {})
      const b64 = await v.evaluate(async () => {
        const el = document.querySelector('iframe, embed, img')
        if (!el?.src) return null
        const r = await fetch(el.src)
        const buf = new Uint8Array(await r.arrayBuffer())
        let s = ''
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        return [btoa(s), r.headers.get('content-type') || '']
      }).catch(() => null)
      if (b64) { keep(Buffer.from(b64[0], 'base64'), b64[1]); log(`📎 ${name}`) }
    } finally { await v?.close().catch(() => {}) }
  }
}

const extOf = (buf, type) => buf.subarray(0, 4).toString() === '%PDF' ? '.pdf'
  : buf[0] === 0x89 ? '.png' : /webp/.test(type) ? '.webp' : '.jpg'

/** The run's work after the Musaned sign-in. Returns the worker's result. */
export async function importFromHrPoolInRun(page, ctx) {
  const db = ctx.db
  const log = (m, level = 'info') => ctx.onLog?.(level, m)
  const p = await db('profiles').where('id', ctx.profileId).first()
  const passport = String(p?.passport_number || '').trim().toUpperCase()
  if (!passport) return { ok: false, error: 'Profile is missing the passport number' }
  page.__adalAllowImages = true // her pictures are what this run is for

  const files = catchFiles(page)
  let pairs = {}
  try {
    if (!(await openHerRow(page, passport, log))) {
      const msg = `Passport ${passport} is not in our Musaned HR Pool list`
      log(msg, 'error')
      await ctx.notify?.(`❌ ${ctx.profileName}: not found on Musaned`, msg)
      return { ok: false, error: msg }
    }
    log('📄 her page on Musaned')
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => {})
    await sleep(2500)
    // Lazy pictures: scroll the page through once.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150)) } window.scrollTo(0, 0) }).catch(() => {})
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {})
    pairs = await readPairs(page).catch(() => ({}))
    if (files.got.length < 2) await openFileLinks(page, files.keep, log).catch(e => log(`file links: ${e.message}`, 'warn'))
  } finally { files.stop() }
  log(`${files.got.length} file(s) from her Musaned page — reading them`)
  if (!files.got.length) {
    const msg = 'Her Musaned page showed no passport or photo to copy'
    await ctx.notify?.(`⚠️ ${ctx.profileName}: nothing to copy`, msg)
    return { ok: false, error: msg }
  }
  return applyMusanedFiles(ctx, files.got, pairs)
}

/**
 * What was copied from her Musaned page → her profile: the passport and the
 * photo saved, every empty field filled, her CV made.
 * files: [{ buf, type }], pairs: { label: value } from her page.
 */
export async function applyMusanedFiles(ctx, got, pairs = {}) {
  const db = ctx.db
  const log = (m, level = 'info') => ctx.onLog?.(level, m)
  const p = await db('profiles').where('id', ctx.profileId).first()
  const passport = String(p?.passport_number || '').trim().toUpperCase()
  const files = { got }

  // Which file is the passport, which the photo.
  fs.mkdirSync(TMP, { recursive: true })
  const { analyzeWithMineru } = await import('./mineruClassifier.js')
  let passportRead = null, passportFile = null, photoFile = null
  for (const [i, f] of files.got.entries()) {
    const file = path.join(TMP, `${ctx.runId}-${i}${extOf(f.buf, f.type)}`)
    fs.writeFileSync(file, f.buf)
    let r = null
    try { r = await analyzeWithMineru(file, { db }) } catch (e) { log(`file ${i + 1} not read: ${e.message}`, 'warn') }
    const pp = String(r?.fields?.passport_number || '').toUpperCase()
    if (!passportFile && (r?.doc_type === 'Passport' || pp === passport)) {
      if (pp && pp !== passport) { log(`file ${i + 1} is the passport of ${pp}, not hers — skipped`, 'warn'); continue }
      passportFile = file; passportRead = r
    } else if (!photoFile && (r?.doc_type === 'Photo' || !r)) photoFile = file
  }
  // A face picture and no "Photo" answer: the smallest image that is not the passport.
  if (!photoFile) {
    const imgs = files.got.map((f, i) => ({ i, f })).filter(x => x.f.buf.subarray(0, 4).toString() !== '%PDF')
      .map(x => path.join(TMP, `${ctx.runId}-${x.i}${extOf(x.f.buf, x.f.type)}`)).filter(f => f !== passportFile)
    photoFile = imgs.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0] || null
  }

  const saved = []
  if (passportFile && await saveOnProfile(db, p.id, 'Passport', passportFile, `Passport_${passport}${path.extname(passportFile)}`)) saved.push('passport')
  if (photoFile && await saveOnProfile(db, p.id, 'Photo', photoFile, `Photo_${passport}${path.extname(photoFile)}`)) saved.push('photo')
  log(saved.length ? `✓ saved on her profile: ${saved.join(' and ')}` : 'no passport or photo recognised', saved.length ? 'info' : 'warn')

  // Every empty field: from the passport, then from Musaned's own page.
  const f = passportRead?.fields || {}
  const fromPassport = {
    full_name: f.full_name || [f.given_names, f.surname].filter(Boolean).join(' '),
    date_of_birth: f.date_of_birth, gender: f.sex || f.gender, place_of_birth: f.place_of_birth,
    passport_issue_date: f.date_of_issue || f.passport_issue_date,
    passport_expiry_date: f.date_of_expiry || f.passport_expiry_date, nationality: f.nationality,
  }
  // Musaned's words → Adal Keep's (only clear ones; anything else stays empty).
  const religion = pick(pairs, 'Religion', 'الديانة')
  const marital = pick(pairs, 'Marital Status', 'الحالة الاجتماعية')
  const fromMusaned = {
    religion: /islam|muslim|مسلم/i.test(religion) ? 'Muslim' : /christ|orthodox|مسيح/i.test(religion) ? 'Orthodox' : '',
    marital_status: /single|أعزب|عزباء/i.test(marital) ? 'SINGLE' : /married|متزوج/i.test(marital) ? 'MARRIED'
      : /divorc|مطلق/i.test(marital) ? 'DIVORCED' : /widow|أرمل/i.test(marital) ? 'WIDOWED' : '',
  }
  const now = await db('profiles').where('id', p.id).first()
  const upd = {}
  for (const [k, v] of Object.entries({ ...fromMusaned, ...fromPassport })) {
    if (v && !String(now[k] || '').trim()) upd[k] = String(v).trim()
  }
  if (Object.keys(upd).length) {
    await db('profiles').where('id', p.id).update({ ...upd, updated_at: new Date().toISOString() })
    log(`✓ filled: ${Object.keys(upd).join(', ')}`)
  }
  if (saved.includes('passport')) {
    try { const { runPassportVerification } = await import('./verification.js'); await runPassportVerification(p.id, { handle: db }) } catch {}
  }
  if (passportFile) {
    try { const { fillPassportDetails } = await import('./passportDetails.js'); await fillPassportDetails(db, p.id, passportFile, (m) => log(m)) } catch {}
  }

  // Her CV with the chosen template.
  let cvNote = ''
  const templateId = Number(ctx.cv_template_id) || (await db('cv_templates').where('is_active', 1).orderBy('id').first('id'))?.id
  if (templateId && (passportFile || photoFile)) {
    try {
      const t = await db('cv_templates').where('id', templateId).first()
      const { generateCvFile } = await import('../routes/cv.js')
      const made = await generateCvFile(db, await db('profiles').where('id', p.id).first(), t, {}, 'musaned')
      cvNote = ` · CV made (${t.name})`
      log(`✓ CV made with ${t.name}: ${made.original_name}`)
    } catch (e) { log(`CV not made: ${e.message}`, 'warn'); cvNote = ' · CV not made' }
  }
  for (const n of fs.readdirSync(TMP)) if (n.startsWith(`${ctx.runId}-`)) fs.rmSync(path.join(TMP, n), { force: true })

  const note = `From Musaned: ${saved.join(' + ') || 'nothing saved'}${Object.keys(upd).length ? ` · ${Object.keys(upd).length} field(s) filled` : ''}${cvNote}`
  await ctx.notify?.(`📥 ${ctx.profileName}: added from Musaned`, note)
  return { ok: true, done: true, note }
}
