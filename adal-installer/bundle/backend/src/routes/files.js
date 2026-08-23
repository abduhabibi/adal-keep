import express from 'express'
import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import imageToPdf from 'image-to-pdf'
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

// Upload file with optional format conversion
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

    // 1. Save the ORIGINAL file
    const originalThumb = req.file.mimetype.startsWith('image/') 
      ? await generateThumbnail(req.file.path, req.file.path.replace(/(\.\w+)$/, '_thumb$1')).then(() => getRelativePath(req.file.path.replace(/(\.\w+)$/, '_thumb$1'))) 
      : null
    
    const [origId] = await db('files').insert({
      profile_field_id: fieldId,
      original_name: `Original_${req.file.originalname}`,
      path: getRelativePath(req.file.path),
      mimetype: req.file.mimetype,
      size: req.file.size,
    })
    savedFiles.push({ id: origId, path: req.file.path, mimetype: req.file.mimetype })

    // 2. Convert and save the TARGET format (if requested and different from original)
    if (targetFormat) {
      const isOriginalImage = req.file.mimetype.startsWith('image/')
      const targetIsPdf = targetFormat.toLowerCase() === 'pdf'
      
      let convertedPath = ''
      let convertedMime = ''
      let convertedName = ''

      if (targetIsPdf && isOriginalImage) {
        // Convert Image -> PDF
        convertedPath = req.file.path.replace(/\.\w+$/, '.pdf')
        convertedMime = 'application/pdf'
        convertedName = `PDF_${req.file.originalname.replace(/\.\w+$/, '')}.pdf`
        await convertImageToPdf(req.file.path, convertedPath)
      } else if (!targetIsPdf && !isOriginalImage) {
        // Convert PDF -> Image
        convertedPath = req.file.path.replace(/\.\w+$/, '.jpg')
        convertedMime = 'image/jpeg'
        convertedName = `Image_${req.file.originalname.replace(/\.\w+$/, '')}.jpg`
        await convertPdfToImage(req.file.path, convertedPath)
        // Generate thumbnail for the new image
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
    res.download(file.path, file.original_name)
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
    } else if (file.mimetype.startsWith('image/')) {
      res.sendFile(path.resolve(file.path))
    } else {
      res.status(404).json({ error: 'No thumbnail available' })
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thumbnail' })
  }
})

export default router