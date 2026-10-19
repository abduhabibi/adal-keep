import express from 'express'
import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import imageToPdf from 'image-to-pdf'
import { upload, generateThumbnail, getRelativePath } from '../services/storage.js'

const router = express.Router()

// Resolve a DB `path` to an absolute file on disk.
// Historically two writers used two roots:
//   - AI pipeline:      data/SafeStorage/<basename>
//   - UI upload/tray:   uploads/<profileId>/<fieldId>/<uuid>
// Try every candidate so both work.
function resolveStoredPath(file) {
  const cwd = process.cwd()
  const raw = file.path || ''
  const base = path.basename(raw)
  const candidates = [
    path.join(cwd, 'data/SafeStorage', raw),   // AI files (basename) + data/SafeStorage/<subpath>
    path.join(cwd, raw),                        // uploads/... paths
    path.join(cwd, 'data/SafeStorage', base),   // basename fallback
    path.join(cwd, 'uploads', base),            // last-ditch
  ]
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}

// Also try to locate a thumbnail next to the resolved original.
function resolveThumbPath(originalAbs) {
  if (!originalAbs) return null
  const dir = path.dirname(originalAbs)
  const name = path.basename(originalAbs)
  const stem = name.replace(/\.\w+$/, '')
  const candidates = [
    path.join(dir, 'thumbnails', 'thumb_' + stem + '.jpg'),
    path.join(dir, 'thumbnails', 'thumb_' + name),
    path.join(dir, stem + '_thumb.jpg'),
    path.join(dir, stem + '_thumb' + path.extname(name)),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return null
}

// Helper to convert Image to PDF
const convertImageToPdf = async (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    imageToPdf([inputPath])
      .pipe(fs.createWriteStream(outputPath))
      .on('finish', resolve)
      .on('error', reject)
  })
}

// Helper to convert PDF to Image (First page)
const convertPdfToImage = async (inputPath, outputPath) => {
  try {
    await sharp(inputPath, { pdf: { page: 1 } })
      .jpeg({ quality: 90 })
      .toFile(outputPath)
    return true
  } catch (err) {
    console.error('PDF to Image conversion failed:', err)
    return false
  }
}

/* ==========================================================================
   TRAY ROUTES (Capturing & Unassigned Files)
   ========================================================================== */

// 1. Fetch all unassigned tray files
router.get('/files/tray', async (req, res) => {
  try {
    const db = req.app.locals.db
    const files = await db('files')
      .whereNull('profile_field_id')
      .orderBy('id', 'desc')
    res.json(files)
  } catch (err) {
    console.error('Failed to fetch tray files:', err)
    res.status(500).json({ error: 'Failed to load tray files' })
  }
})

// 2. Capture uploaded file directly into the Tray (unassigned)
router.post('/files/tray', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const db = req.app.locals.db
    const isImage = req.file.mimetype.startsWith('image/')

    if (isImage) {
      const thumbPath = req.file.path.replace(/(\.\w+)$/, '_thumb$1')
      await generateThumbnail(req.file.path, thumbPath)
    }

    const [fileId] = await db('files').insert({
      profile_field_id: null,
      original_name: req.file.originalname,
      path: getRelativePath(req.file.path),
      mimetype: req.file.mimetype,
      size: req.file.size,
    })

    const newFile = await db('files').where('id', fileId).first()
    res.status(201).json(newFile)
  } catch (err) {
    console.error('Tray upload error:', err)
    res.status(500).json({ error: 'Failed to upload file to tray' })
  }
})

// 3. Assign/Move a file from Tray to a Profile Field (Drag and Drop destination)
router.post('/profiles/:id/fields/:fieldId/assign-tray-file', async (req, res) => {
  try {
    const { id: profileId, fieldId } = req.params
    const { fileId } = req.body

    if (!fileId) return res.status(400).json({ error: 'fileId is required' })

    const db = req.app.locals.db

    const field = await db('profile_fields')
      .where('id', fieldId)
      .andWhere('profile_id', profileId)
      .first()

    if (!field) return res.status(404).json({ error: 'Profile field not found' })

    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    // Optionally clean up existing files for this field if it only holds one
    const oldFiles = await db('files').where('profile_field_id', fieldId)
    for (const oldFile of oldFiles) {
      if (fs.existsSync(oldFile.path)) fs.unlinkSync(oldFile.path)
      const thumbPath = oldFile.path.replace(/(\.\w+)$/, '_thumb$1')
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)
    }
    await db('files').where('profile_field_id', fieldId).del()

    // Assign file to profile field
    await db('files').where('id', fileId).update({ profile_field_id: fieldId })

    const updatedFile = await db('files').where('id', fileId).first()
    res.json({ success: true, file: updatedFile })
  } catch (err) {
    console.error('Assign tray file error:', err)
    res.status(500).json({ error: 'Failed to assign tray file to profile field' })
  }
})

/* ==========================================================================
   PROFILE FIELD FILES ROUTES
   ========================================================================== */

// Upload file to specific field with optional format conversion
router.post('/profiles/:id/fields/:fieldId/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const { id: profileId, fieldId } = req.params
    const { targetFormat } = req.body // 'image' or 'pdf'
    const db = req.app.locals.db

    const field = await db('profile_fields').where('id', fieldId).andWhere('profile_id', profileId).first()
    if (!field) return res.status(404).json({ error: 'Profile field not found' })

    // Delete old files for this field
    const oldFiles = await db('files').where('profile_field_id', fieldId)
    for (const oldFile of oldFiles) {
      if (fs.existsSync(oldFile.path)) fs.unlinkSync(oldFile.path)
      const thumbPath = oldFile.path.replace(/(\.\w+)$/, '_thumb$1')
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)
    }
    await db('files').where('profile_field_id', fieldId).del()

    const savedFiles = []

    // 1. Save ORIGINAL file
    if (req.file.mimetype.startsWith('image/')) {
      const thumbPath = req.file.path.replace(/(\.\w+)$/, '_thumb$1')
      await generateThumbnail(req.file.path, thumbPath)
    }

    const [origId] = await db('files').insert({
      profile_field_id: fieldId,
      original_name: `Original_${req.file.originalname}`,
      path: getRelativePath(req.file.path),
      mimetype: req.file.mimetype,
      size: req.file.size,
    })
    savedFiles.push({ id: origId, path: req.file.path, mimetype: req.file.mimetype })

    // 2. Convert and save TARGET format if requested
    if (targetFormat) {
      const isOriginalImage = req.file.mimetype.startsWith('image/')
      const targetIsPdf = targetFormat.toLowerCase() === 'pdf'

      let convertedPath = ''
      let convertedMime = ''
      let convertedName = ''

      if (targetIsPdf && isOriginalImage) {
        convertedPath = req.file.path.replace(/\.\w+$/, '.pdf')
        convertedMime = 'application/pdf'
        convertedName = `PDF_${req.file.originalname.replace(/\.\w+$/, '')}.pdf`
        await convertImageToPdf(req.file.path, convertedPath)
      } else if (!targetIsPdf && !isOriginalImage) {
        convertedPath = req.file.path.replace(/\.\w+$/, '.jpg')
        convertedMime = 'image/jpeg'
        convertedName = `Image_${req.file.originalname.replace(/\.\w+$/, '')}.jpg`
        await convertPdfToImage(req.file.path, convertedPath)
        await generateThumbnail(convertedPath, convertedPath.replace(/(\.\w+)$/, '_thumb$1'))
      }

      if (convertedPath && fs.existsSync(convertedPath)) {
        const [convId] = await db('files').insert({
          profile_field_id: fieldId,
          original_name: convertedName,
          path: getRelativePath(convertedPath),
          mimetype: convertedMime,
          size: fs.statSync(convertedPath).size,
        })
        savedFiles.push({ id: convId, path: convertedPath, mimetype: convertedMime })
      }
    }

    res.json({ success: true, files: savedFiles })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: 'Failed to upload/convert file' })
  }
})

// Get files for a profile field
router.get('/profiles/:id/fields/:fieldId/files', async (req, res) => {
  try {
    const { id: profileId, fieldId } = req.params
    const db = req.app.locals.db
    const files = await db('files')
      .leftJoin('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.id', fieldId)
      .select('files.*')
    res.json(files)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load files' })
  }
})

/* ==========================================================================
   FILE MANAGEMENT & DOWNLOADS
   ========================================================================== */

// Delete file
router.delete('/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params
    const db = req.app.locals.db
    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    const fullPath = resolveStoredPath(file)
    if (fullPath) try { fs.unlinkSync(fullPath) } catch {}
    // Also delete a thumbnail if present
    const thumb = resolveThumbPath(fullPath)
    if (thumb) try { fs.unlinkSync(thumb) } catch {}

    await db('files').where('id', fileId).del()
    res.json({ success: true })
  } catch (err) {
    console.error('Delete error:', err)
    res.status(500).json({ error: 'Failed to delete file' })
  }
})

// Serve file for download
router.get('/files/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params
    const db = req.app.locals.db
    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    const fullPath = resolveStoredPath(file)
    if (!fullPath) return res.status(404).json({ error: 'File not found on disk' })

    res.download(fullPath, file.original_name || path.basename(fullPath))
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: 'Failed to download file' })
  }
})

// Serve thumbnail
router.get('/files/:fileId/thumbnail', async (req, res) => {
  try {
    const { fileId } = req.params
    const db = req.app.locals.db
    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    const fullPath = resolveStoredPath(file)
    if (!fullPath) return res.status(404).json({ error: 'File not found on disk' })

    // Prefer a real thumbnail if one exists; else send the file itself
    const thumb = resolveThumbPath(fullPath)
    res.sendFile(thumb || fullPath)
  } catch (err) {
    console.error('Thumbnail error:', err)
    res.status(500).json({ error: 'Failed to load thumbnail' })
  }
})

/* ==========================================================================
   ENCRYPTED UPLOAD ROUTE
   ========================================================================== */

/* MULTI-FILE-ROUTE-MARKER — appends (does not replace) files to a field */
router.post('/profiles/:id/fields/:fieldId/files', upload.array('files', 20), async (req, res) => {
  try {
    const { id: profileId, fieldId } = req.params
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' })
    const db = req.app.locals.db
    const field = await db('profile_fields').where('id', fieldId).andWhere('profile_id', profileId).first()
    if (!field) return res.status(404).json({ error: 'Profile field not found' })
    const inserted = []
    for (const f of req.files) {
      if (f.mimetype.startsWith('image/')) {
        const thumbPath = f.path.replace(/(\.\w+)$/, '_thumb$1')
        try { await generateThumbnail(f.path, thumbPath) } catch (e) {}
      }
      const [fileId] = await db('files').insert({
        profile_field_id: fieldId,
        original_name: f.originalname,
        path: getRelativePath(f.path),
        mimetype: f.mimetype,
        size: f.size,
      })
      inserted.push(await db('files').where('id', fileId).first())
    }

    res.status(201).json({ success: true, files: inserted })
  } catch (err) {
    console.error('Multi-upload error:', err)
    res.status(500).json({ error: 'Failed to upload files' })
  }
})

export default router