import express from 'express'
import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import imageToPdf from 'image-to-pdf'
import crypto from 'crypto'
import { upload, generateThumbnail, getRelativePath } from '../services/storage.js'

const router = express.Router()

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

    if (fs.existsSync(file.path)) fs.unlinkSync(file.path)
    const thumbPath = file.path.replace(/(\.\w+)$/, '_thumb$1')
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)

    await db('files').where('id', fileId).del()
    res.json({ success: true })
  } catch (err) {
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

    const fullPath = path.resolve(file.path)
    res.download(fullPath, file.original_name)
  } catch (err) {
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

    const thumbPath = file.path.replace(/(\.\w+)$/, '_thumb$1')
    if (fs.existsSync(thumbPath)) {
      res.sendFile(path.resolve(thumbPath))
    } else if (file.mimetype && file.mimetype.startsWith('image/')) {
      res.sendFile(path.resolve(file.path))
    } else {
      res.status(404).json({ error: 'No thumbnail available' })
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thumbnail' })
  }
})

/* ==========================================================================
   ENCRYPTED UPLOAD ROUTE
   ========================================================================== */

router.post('/upload-encrypted', upload.single('file'), async (req, res) => {
  try {
    if (!req.body.encrypted || req.body.encrypted !== 'true') {
      return res.status(400).json({ error: 'Encrypted flag required' })
    }

    const encryptKey = process.env.ADAL_ENCRYPT_KEY || 'adal-keep-default-key-change-me!!!!'
    const key = crypto.createHash('sha256').update(encryptKey).digest()
    const encryptedB64 = req.file.buffer ? req.file.buffer.toString('utf8') : fs.readFileSync(req.file.path, 'utf8')
    const encryptedBytes = Buffer.from(encryptedB64, 'base64')

    const iv = encryptedBytes.subarray(0, 12)
    const ciphertext = encryptedBytes.subarray(12)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    const originalExt = req.body.original_ext || '.jpg'
    const filename = req.body.filename || `upload_${Date.now()}${originalExt}`
    const safeName = `${crypto.randomUUID()}${originalExt}`
    const uploadDir = path.resolve('./uploads/temp')

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }

    const tempPath = path.join(uploadDir, safeName)
    fs.writeFileSync(tempPath, decrypted)

    const fileUrl = `/uploads/temp/${safeName}`

    res.json({
      success: true,
      url: fileUrl,
      path: tempPath,
      filename: filename,
      decrypted: true,
      message: 'File decrypted and stored securely',
    })
  } catch (err) {
    console.error('Encrypted upload error:', err.message)
    res.status(500).json({ error: 'Decryption or storage failed' })
  }
})

export default router