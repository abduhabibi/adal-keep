import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { ingestTemplate } from '../services/cvTemplateIngest.js'
import { buildTemplateData, mergeTemplate, htmlToPdf } from '../services/cvRender.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')
if (!fs.existsSync(SAFE_STORAGE_DIR)) fs.mkdirSync(SAFE_STORAGE_DIR, { recursive: true })

const TMP_TPL = path.join(__dirname, '../../data/tmp-templates')
if (!fs.existsSync(TMP_TPL)) fs.mkdirSync(TMP_TPL, { recursive: true })

const router = express.Router()

const tplStorage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, TMP_TPL),
  filename: (req, f, cb) => cb(null, Date.now() + '_' + uuid() + path.extname(f.originalname)),
})
const tplUpload = multer({
  storage: tplStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const ok = f.mimetype.startsWith('image/') || f.mimetype === 'application/pdf'
    cb(ok ? null : new Error('Only image or PDF'), ok)
  },
})

router.post('/templates/upload', tplUpload.array('files', 30), async (req, res) => {
  const db = req.app.locals.db
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' })
  const results = []
  for (const f of req.files) {
    try {
      console.log('[CV] ingesting template ' + f.originalname)
      const meta = await ingestTemplate(f.path, f.originalname, f.mimetype)
      const [id] = await db('cv_templates').insert({
        name: meta.name,
        agency_name: meta.agency_name,
        agency_name_ar: meta.agency_name_ar,
        salary: meta.salary || null,
        currency: meta.currency,
        country: meta.country,
        contract_years: meta.contract_years,
        html_content: meta.html_content,
        css_content: meta.css_content,
        placeholders: meta.placeholders,
        source_file: f.originalname,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      results.push({ ok: true, id, name: meta.name, agency_name: meta.agency_name })
    } catch (e) {
      console.error('[CV] ingest failed ' + f.originalname + ': ' + e.message)
      results.push({ ok: false, name: f.originalname, error: e.message })
    } finally {
      try { fs.unlinkSync(f.path) } catch {}
    }
  }
  res.json({ results })
})

router.get('/templates', async (req, res) => {
  try {
    const db = req.app.locals.db
    const rows = await db('cv_templates').select('*').orderBy('name')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/templates/:id', async (req, res) => {
  const db = req.app.locals.db
  const row = await db('cv_templates').where('id', req.params.id).first()
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})


router.delete('/templates/:id', async (req, res) => {
  const db = req.app.locals.db
  const { moveToTrash } = await import('../services/trash.js')
  await moveToTrash(db, 'cv_template', req.params.id, req)
  res.json({ ok: true })
})

router.get('/templates/:id/preview', async (req, res) => {
  try {
    const db = req.app.locals.db
    const tpl = await db('cv_templates').where('id', req.params.id).first()
    if (!tpl) return res.status(404).send('Template not found')
    const dummy = { id: 0, full_name: 'SAMPLE CANDIDATE NAME', first_name: 'SAMPLE', last_name: 'CANDIDATE', nationality: 'ETHIOPIAN', gender: 'F', date_of_birth: '1999-05-31', passport_number: 'EP0000000', place_of_birth: 'SAMPLE TOWN', religion: 'MUSLIM', marital_status: 'SINGLE', children_count: 0, weight: 'Normal', height: 'Normal', complexion: '-', living_town: 'SAMPLE', mother_name: 'SAMPLE MOTHER', father_name: 'SAMPLE FATHER', spouse_name: '', phone_number: '0912345678', education_level: '-', speaks_english: false, speaks_arabic: false, skills: JSON.stringify({ cleaning: true, ironing: true, washing: true, baby_sitting: true, cooking: false }), previous_employment: JSON.stringify([]) }
    const data = await buildTemplateData(db, dummy, tpl, {})
    const html = mergeTemplate(tpl.html_content, tpl.css_content, data)
    res.set('Content-Type', 'text/html').send(html)
  } catch (e) { res.status(500).send('Preview failed: ' + e.message) }
})

router.get('/generated', async (req, res) => {
  try {
    const db = req.app.locals.db
    let q = db('generated_cvs')
      .leftJoin('profiles', 'generated_cvs.profile_id', 'profiles.id')
      .leftJoin('cv_templates', 'generated_cvs.template_id', 'cv_templates.id')
      .select('generated_cvs.*', 'profiles.full_name as profile_name', 'profiles.passport_number', 'cv_templates.name as template_name', 'cv_templates.agency_name')
      .orderBy('generated_cvs.created_at', 'desc')
    if (req.query.profile_id) q = q.where('generated_cvs.profile_id', req.query.profile_id)
    // The list leaves out each CV's full copy of the data (1–2 MB each; no page shows it).
    res.json((await q).map(({ data_snapshot, ...c }) => c))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/generated/:id/download', async (req, res) => {
  const db = req.app.locals.db
  const row = await db('generated_cvs').where('id', req.params.id).first()
  if (!row) return res.status(404).json({ error: 'Not found' })
  const fullPath = path.join(SAFE_STORAGE_DIR, row.pdf_path)
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' })
  res.download(fullPath, path.basename(row.filename || row.pdf_path))
})

router.delete('/generated/:id', async (req, res) => {
  const db = req.app.locals.db
  const row = await db('generated_cvs').where('id', req.params.id).first()
  if (!row) return res.status(404).json({ error: 'Not found' })
  const { moveToTrash } = await import('../services/trash.js')
  await moveToTrash(db, 'generated_cv', row.id, req)
  res.json({ ok: true })
})

router.get('/profile-readiness/:profileId', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const profile = await db('profiles').where('id', profileId).first()
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    const required = ['full_name','first_name','last_name','passport_number','date_of_birth','place_of_birth','nationality','gender','religion','marital_status','children_count','weight','height','living_town','phone_number']
    const missing = required.filter(k => {
      const v = profile[k]
      return v === null || v === undefined || v === ''
    })

    const counts = await db('profile_fields')
      .leftJoin('files', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .groupBy('profile_fields.name')
      .select('profile_fields.name')
      .count('files.id as file_count')

    const fileMap = {}
    for (const row of counts) fileMap[row.name] = Number(row.file_count || 0)

    const has_photo = (fileMap['Photo'] || 0) > 0 || !!profile.photo_path
    const has_full_body_photo = (fileMap['Full Body Photo'] || 0) > 0

    // ---- CV-generation blockers ----
    const cv_blockers = []
    if (!profile.broker_id) cv_blockers.push('Broker not assigned')
    if (!has_photo) cv_blockers.push('Photo missing')
    if (!has_full_body_photo) cv_blockers.push('Full body photo missing')
    // No labor ID needed: the CV goes to Musaned, which does not use one.
    if (!profile.religion) cv_blockers.push('Religion missing')
    if (!profile.marital_status) cv_blockers.push('Marital status missing')

    const can_generate = cv_blockers.length === 0


    res.json({
      profile,
      missing,
      has_photo,
      has_full_body_photo,
      field_file_counts: fileMap,
      missing_photos: [
        !has_photo ? 'Photo' : null,
        !has_full_body_photo ? 'Full Body Photo' : null,
      ].filter(Boolean),
      cv_blockers,
      can_generate,
    })
  } catch (e) {
    console.error('[CV] readiness error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/generate', async (req, res) => {
  const db = req.app.locals.db
  try {
    const { profile_id, template_id, overrides = {} } = req.body || {}
    if (!profile_id || !template_id) return res.status(400).json({ error: 'profile_id and template_id required' })
    const profile = await db('profiles').where('id', profile_id).first()
    if (!profile) return res.status(404).json({ error: 'Profile not found' })
    const template = await db('cv_templates').where('id', template_id).first()
    if (!template) return res.status(404).json({ error: 'Template not found' })

    const cvUpd = {}
    const stringKeys = [
      'religion','marital_status','weight','height','complexion','living_town',
      'mother_name','father_name','spouse_name','education_level',
      'region','zone_subcity','labor_id','personal_number',
      'emergency_name','emergency_phone','emergency_gender','emergency_relationship',
      'cooking_skill',
    ]
    for (const k of stringKeys) if (overrides[k] !== undefined) cvUpd[k] = overrides[k]
    if (overrides.children_count !== undefined) cvUpd.children_count = parseInt(overrides.children_count, 10) || 0
    if (overrides.speaks_english !== undefined) cvUpd.speaks_english = !!overrides.speaks_english
    if (overrides.speaks_arabic !== undefined) cvUpd.speaks_arabic = !!overrides.speaks_arabic
    for (const k of ['english_read', 'english_write', 'arabic_read', 'arabic_write']) if (overrides[k] !== undefined) cvUpd[k] = !!overrides[k]
    if (overrides.skills !== undefined) cvUpd.skills = JSON.stringify(overrides.skills)
    if (overrides.previous_employment !== undefined) cvUpd.previous_employment = JSON.stringify(overrides.previous_employment)
    if (Object.keys(cvUpd).length) { cvUpd.updated_at = new Date().toISOString(); await db('profiles').where('id', profile.id).update(cvUpd) }
    const fresh = await db('profiles').where('id', profile.id).first()

    const data = await buildTemplateData(db, fresh, template, overrides)
    const html = mergeTemplate(template.html_content, template.css_content, data)

    const slug = (fresh.full_name || 'profile').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)
    const tslug = (template.name || 'template').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)
    const filename = 'AdalCV_' + fresh.id + '_' + slug + '_' + tslug + '_' + Date.now() + '.pdf'
    const outPath = path.join(SAFE_STORAGE_DIR, filename)

    try { await htmlToPdf(html, outPath) }
    catch (e) { return res.status(500).json({ error: 'PDF render failed: ' + e.message }) }

    let cvField = await db('profile_fields').where('profile_id', fresh.id).andWhere('name', 'CV').first()
    if (!cvField) {
      const tpl = await db('field_templates').where('name', 'CV').first()
      const [fid] = await db('profile_fields').insert({ profile_id: fresh.id, field_template_id: tpl ? tpl.id : null, name: 'CV', data_type: 'file', is_permanent: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      cvField = { id: fid }
    }

    const size = fs.statSync(outPath).size
    const [fileId] = await db('files').insert({ profile_field_id: cvField.id, original_name: slug + '_' + tslug + '.pdf', path: filename, mimetype: 'application/pdf', size, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })

    const [cvsId] = await db('generated_cvs').insert({ profile_id: fresh.id, template_id: template.id, filename, data_snapshot: JSON.stringify(data), pdf_path: filename, created_by: 'user', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })

    res.json({ ok: true, generated_cv_id: cvsId, file_id: fileId, filename, download_url: '/api/files/' + fileId + '/download' })
  } catch (e) {
    console.error('[CV] generate error: ' + e.message)
    res.status(500).json({ error: e.message })
  }
})

const headerStorage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, SAFE_STORAGE_DIR),
  filename: (req, f, cb) => cb(null, 'cvheader_' + Date.now() + '_' + uuid() + path.extname(f.originalname)),
})
const headerUpload = multer({ storage: headerStorage, limits: { fileSize: 15 * 1024 * 1024 } })

// Header / footer banner: upload (or replace) and remove. The old image is
// deleted once no template uses it.
async function dropImage(db, file) {
  if (!file) return
  const used = await db('cv_templates').where('header_path', file).orWhere('footer_path', file).first()
  if (!used) fs.promises.unlink(path.join(SAFE_STORAGE_DIR, path.basename(file))).catch(() => {})
}

for (const kind of ['header', 'footer']) {
  const col = kind + '_path'
  router.post(`/templates/:id/${kind}`, headerUpload.single(kind), async (req, res) => {
    try {
      const db = req.app.locals.db
      if (!req.file) return res.status(400).json({ error: `No ${kind} image` })
      const tpl = await db('cv_templates').where('id', req.params.id).first()
      if (!tpl) { fs.promises.unlink(req.file.path).catch(() => {}); return res.status(404).json({ error: 'Template not found' }) }
      const filename = path.basename(req.file.path)
      await db('cv_templates').where('id', tpl.id).update({ [col]: filename, updated_at: new Date().toISOString() })
      await dropImage(db, tpl[col])
      res.json({ ok: true, [col]: filename })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.delete(`/templates/:id/${kind}`, async (req, res) => {
    try {
      const db = req.app.locals.db
      const tpl = await db('cv_templates').where('id', req.params.id).first()
      if (!tpl) return res.status(404).json({ error: 'Template not found' })
      await db('cv_templates').where('id', tpl.id).update({ [col]: null, updated_at: new Date().toISOString() })
      await dropImage(db, tpl[col])
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
}

router.patch('/templates/:id', async (req, res) => {
  const db = req.app.locals.db
  const fields = ['name','agency_name','agency_name_ar','salary','currency','country','contract_years','is_active','include_passport','footer_path','passport_h1','passport_h1_color','passport_include_header','passport_include_footer']
  const upd = {}
  for (const k of fields) if (req.body[k] !== undefined) upd[k] = req.body[k]
  if (Object.keys(upd).length === 0) return res.json({ ok: true })
  upd.updated_at = new Date().toISOString()
  await db('cv_templates').where('id', req.params.id).update(upd)
  res.json({ ok: true })
})

router.post('/generated/:id/reformat', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { template_id } = req.body || {}
    if (!template_id) return res.status(400).json({ error: 'template_id required' })
    const row = await db('generated_cvs').where('id', req.params.id).first()
    if (!row) return res.status(404).json({ error: 'Generated CV not found' })
    const template = await db('cv_templates').where('id', template_id).first()
    if (!template) return res.status(404).json({ error: 'Template not found' })
    const profile = await db('profiles').where('id', row.profile_id).first()
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    const data = JSON.parse(row.data_snapshot || '{}')
    const freshData = await buildTemplateData(db, profile, template, data)
    const html = mergeTemplate(template.html_content, template.css_content, freshData)

    const slug = (profile.full_name || 'profile').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)
    const tslug = (template.name || 'template').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)
    const filename = 'AdalCV_' + profile.id + '_' + slug + '_' + tslug + '_' + Date.now() + '.pdf'
    const outPath = path.join(SAFE_STORAGE_DIR, filename)
    await htmlToPdf(html, outPath)

    const size = fs.statSync(outPath).size
    let cvField = await db('profile_fields').where('profile_id', profile.id).andWhere('name', 'CV').first()
    if (!cvField) {
      const tpl = await db('field_templates').where('name', 'CV').first()
      const [fid] = await db('profile_fields').insert({ profile_id: profile.id, field_template_id: tpl ? tpl.id : null, name: 'CV', data_type: 'file', is_permanent: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      cvField = { id: fid }
    }
    const [fileId] = await db('files').insert({ profile_field_id: cvField.id, original_name: slug + '_' + tslug + '.pdf', path: filename, mimetype: 'application/pdf', size, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    const [newId] = await db('generated_cvs').insert({ profile_id: profile.id, template_id: template.id, filename, data_snapshot: JSON.stringify(freshData), pdf_path: filename, created_by: 'reformat', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })

    res.json({ ok: true, generated_cv_id: newId, file_id: fileId, filename, download_url: '/api/files/' + fileId + '/download' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/templates/:id/header-image', async (req, res) => {
  const db = req.app.locals.db
  const tpl = await db('cv_templates').where('id', req.params.id).first()
  if (!tpl?.header_path) return res.status(404).end()
  const fp = path.join(SAFE_STORAGE_DIR, tpl.header_path)
  if (!fs.existsSync(fp)) return res.status(404).end()
  res.sendFile(fp)
})

router.get('/templates/:id/footer-image', async (req, res) => {
  const db = req.app.locals.db
  const tpl = await db('cv_templates').where('id', req.params.id).first()
  if (!tpl?.footer_path) return res.status(404).end()
  const fp = path.join(SAFE_STORAGE_DIR, tpl.footer_path)
  if (!fs.existsSync(fp)) return res.status(404).end()
  res.sendFile(fp)
})


// POST /api/cv/preview — render merged HTML for any profile × template combo.
// Does NOT save a PDF. Used by the CV form's live preview modal.
router.post('/preview', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { profile_id, template_id, overrides = {} } = req.body || {}
    if (!profile_id || !template_id) return res.status(400).json({ error: 'profile_id and template_id required' })
    const profile = await db('profiles').where('id', profile_id).first()
    if (!profile) return res.status(404).json({ error: 'Profile not found' })
    const template = await db('cv_templates').where('id', template_id).first()
    if (!template) return res.status(404).json({ error: 'Template not found' })

    const data = await buildTemplateData(db, profile, template, overrides)
    const html = mergeTemplate(template.html_content, template.css_content, data)
    res.set('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch (e) {
    console.error('[CV] preview error:', e.message)
    res.status(500).send('Preview failed: ' + e.message)
  }
})


router.put('/templates/:id/content', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { html_content, css_content } = req.body || {}
    if (!html_content || !html_content.trim()) return res.status(400).json({ error: 'html_content required' })
    const placeholders = JSON.stringify(
      Array.from(new Set((html_content.match(/\{\{[A-Z_]+\}\}/g) || [])))
    )
    await db('cv_templates').where('id', req.params.id).update({
      html_content,
      css_content: css_content || '',
      placeholders,
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})


// POST /api/cv/templates — create from JSON (manual editor, no AI)
router.post('/templates', async (req, res) => {
  try {
    const db = req.app.locals.db
    const b = req.body || {}
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' })
    if (!b.html_content || !String(b.html_content).trim()) return res.status(400).json({ error: 'html_content is required' })

    const placeholders = JSON.stringify(
      Array.from(new Set((b.html_content.match(/\{\{[A-Z_]+\}\}/g) || [])))
    )

    const [id] = await db('cv_templates').insert({
      name: String(b.name).trim().toUpperCase(),
      agency_name: b.agency_name || '',
      agency_name_ar: b.agency_name_ar || '',
      salary: b.salary ? parseInt(b.salary, 10) : null,
      currency: b.currency || 'SAR',
      country: b.country || '',
      contract_years: b.contract_years ? parseInt(b.contract_years, 10) : 2,
      html_content: b.html_content,
      css_content: b.css_content || '',
      placeholders,
      source_file: 'manual',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true, id })
  } catch (e) {
    console.error('[CV] create template error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/cv/templates/preview-html — merge dummy data into supplied HTML+CSS
router.post('/templates/preview-html', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { html_content, css_content, template_id } = req.body || {}
    let html = html_content, css = css_content
    // The editor's template: its saved header, footer and passport page, with the HTML being edited.
    const t = template_id ? await db('cv_templates').where('id', template_id).first() : null
    if ((!html || !html.trim()) && t) { html = t.html_content; css = t.css_content }
    if (!html) return res.status(400).send('No HTML provided')

    const dummy = {
      id: 0,
      full_name: 'SAMPLE CANDIDATE NAME',
      first_name: 'SAMPLE', last_name: 'CANDIDATE',
      nationality: 'ETHIOPIAN', gender: 'F', date_of_birth: '1999-05-31',
      passport_number: 'EP0000000', place_of_birth: 'SAMPLE TOWN',
      religion: 'MUSLIM', marital_status: 'SINGLE', children_count: 0,
      weight: 'Normal', height: 'Normal', complexion: '-', living_town: 'SAMPLE',
      mother_name: 'SAMPLE MOTHER', father_name: 'SAMPLE FATHER', spouse_name: '',
      phone_number: '0912345678', education_level: '-',
      speaks_english: false, speaks_arabic: false,
      skills: JSON.stringify({ cleaning: true, ironing: true, washing: true, baby_sitting: true, cooking: false }),
      previous_employment: JSON.stringify([]),
      labor_id: 'LAB-0001',
      emergency_name: 'SAMPLE FATHER', emergency_phone: '0911111111',
      emergency_gender: 'Male', emergency_relationship: 'Father',
      region: 'Addis Ababa', zone_subcity: 'Bole',
    }
    const dummyTemplate = t ? { ...t, salary: t.salary ?? 1000, currency: t.currency || 'SAR', country: t.country || 'SA', contract_years: t.contract_years || 2 }
                            : { salary: 1000, currency: 'SAR', country: 'SA', contract_years: 2 }
    // A new design (Create template): its header, passport page and title colour before it is saved.
    const b = req.body || {}
    if (b.include_passport !== undefined) Object.assign(dummyTemplate, { include_passport: b.include_passport ? 1 : 0, passport_h1: b.passport_h1 ?? 'Passport', passport_h1_color: b.passport_h1_color || '#000000', passport_include_header: 1 })
    const data = await buildTemplateData(db, dummy, dummyTemplate, {})
    if (typeof b.header_data_url === 'string' && /^data:image\//.test(b.header_data_url)) data.HEADER_IMAGE = b.header_data_url
    if (data.PASSPORT_PAGE_INCLUDE && !data.PASSPORT_URL) {
      data.PASSPORT_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="480"><rect width="700" height="480" rx="18" fill="#e5e7eb"/><text x="350" y="250" font-family="Arial" font-size="30" fill="#9ca3af" text-anchor="middle">Her passport page</text></svg>')
    }
    const merged = mergeTemplate(html, css || '', data)
    res.set('Content-Type', 'text/html; charset=utf-8').send(merged)
  } catch (e) {
    console.error('[CV] preview-html error:', e.message)
    res.status(500).send('Preview failed: ' + e.message)
  }
})


export default router
