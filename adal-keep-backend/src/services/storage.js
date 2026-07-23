import multer from 'multer'
import sharp from 'sharp'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import db from '../config/database.js'

const UPLOAD_DIR = './uploads'

// Ensure root uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// 1. Configure Multer Disk Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const profileId = req.params.id || req.body.profile_id || 'general'
    const fieldId = req.params.fieldId || req.body.field_id || 'unassigned'

    const uploadPath = path.join(UPLOAD_DIR, String(profileId), String(fieldId))
    fs.mkdirSync(uploadPath, { recursive: true })
    cb(null, uploadPath)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${uuidv4()}${ext}`)
  },
})

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
    cb(null, true)
  } else {
    cb(new Error('Only images and PDFs are allowed'), false)
  }
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
})

// 2. Thumbnail Generation Helper
export async function generateThumbnail(filePath) {
  try {
    const dir = path.dirname(filePath)
    const filename = path.basename(filePath)
    const thumbDir = path.join(dir, 'thumbnails')

    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true })
    }

    const thumbFullPath = path.join(thumbDir, `thumb_${filename}`)

    await sharp(filePath)
      .resize(200, 200, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 80 })
      .toFile(thumbFullPath)

    return thumbFullPath
  } catch (err) {
    console.error('Thumbnail generation failed:', err)
    return null
  }
}

// 3. Process Multer File & Save Record to Database
export async function saveUploadedFile({ fieldId, file, uploadedBy }) {
  const field = await db('profile_fields').where({ id: fieldId }).first()
  if (!field) throw new Error('Field not found')

  let thumbnailPath = null
  if (file.mimetype.startsWith('image/')) {
    thumbnailPath = await generateThumbnail(file.path)
  }

  const payload = {
    profile_field_id: fieldId,
    original_filename: file.originalname,
    stored_path: file.path,
    thumbnail_path: thumbnailPath,
    mime_type: file.mimetype,
    size_bytes: file.size,
    uploaded_by: uploadedBy || null,
  }

  // Insert record (handles both SQLite and Postgres compatibility)
  const [inserted] = await db('files').insert(payload, ['*'])

  if (typeof inserted === 'object' && inserted !== null) {
    return inserted
  }

  return await db('files').where({ id: inserted }).first()
}

// 4. Memory-Buffer File Saver (Legacy / Direct programmatic uploads)
export async function saveFileBuffer(fieldId, buffer, originalName, mimetype, uploadedBy) {
  const field = await db('profile_fields').where({ id: fieldId }).first()
  if (!field) throw new Error('Field not found')

  const profileDir = path.join(UPLOAD_DIR, String(field.profile_id), String(fieldId))
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
  }

  const ext = path.extname(originalName)
  const filename = `${uuidv4()}${ext}`
  const storedPath = path.join(profileDir, filename)

  fs.writeFileSync(storedPath, buffer)

  let thumbnailPath = null
  if (mimetype.startsWith('image/')) {
    thumbnailPath = await generateThumbnail(storedPath)
  }

  const payload = {
    profile_field_id: fieldId,
    original_filename: originalName,
    stored_path: storedPath,
    thumbnail_path: thumbnailPath,
    mime_type: mimetype,
    size_bytes: buffer.length,
    uploaded_by: uploadedBy || null,
  }

  const [inserted] = await db('files').insert(payload, ['*'])

  if (typeof inserted === 'object' && inserted !== null) {
    return inserted
  }

  return await db('files').where({ id: inserted }).first()
}

// Utility to get relative paths
export function getRelativePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath)
}