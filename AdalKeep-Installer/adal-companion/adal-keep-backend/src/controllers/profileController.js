import db from '../config/database.js'
import { logActivity } from '../services/activityLog.js'
import logger from '../utils/logger.js'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const PHOTO_DIR = 'uploads/photos'

const PERMANENT_FIELD_NAMES = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report',
  'Insurance', 'COC', 'Visa', 'Saudi-letter', 'Musaned',
  'Broker ID', 'Ticket-ongoing', 'Ticket-deported', 'Police Clearance',
  'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID',
  'Self Video', 'Photo'
]

async function createPermanentFields(profileId, employeeName) {
  // Get template IDs for these names
  const templates = await db('field_templates')
    .whereIn('name', PERMANENT_FIELD_NAMES)
    .select('id', 'name', 'data_type')

  for (const t of templates) {
    let value = null

    // Auto‑generate 4‑digit numbers for Broker ID and Client ID
    if (t.name === 'Broker ID' || t.name === 'Client ID') {
      value = Math.floor(1000 + Math.random() * 9000).toString()
    }

    // For Employee ID, fill from the provided employee name
    if (t.name === 'Employee ID') {
      value = employeeName || 'Unknown'
    }

    await db('profile_fields').insert({
      profile_id: profileId,
      field_template_id: t.id,
      name: t.name,
      data_type: t.data_type,
      is_permanent: true,
      value_text: value,
      created_by: employeeName || 'System'
    })
  }
}

// Ensure photo directory exists on startup
async function ensurePhotoDir() {
  try {
    await fs.mkdir(PHOTO_DIR, { recursive: true })
  } catch (err) {
    // directory already exists
  }
}
ensurePhotoDir()

function sessionUserId(req) {
  return req.auth?.uid || req.session?.userId || null
}
async function resolveCreatorName(req) {
  const uid = sessionUserId(req)
  if (req.auth?.role === 'owner') return 'Owner'
  if (!uid) return 'System'
  try {
    const u = await req.app.locals.db('users').where({ id: uid }).first()
    return (u?.name || u?.username || String(uid)).trim()
  } catch {
    return String(uid)
  }
}

// Helper function to prune orphaned physical locations safely
async function cleanupOrphanedLocation(locationId) {
  if (!locationId) return
  try {
    const count = await db('profiles')
      .where({ physical_location_id: locationId })
      .count('id as cnt')
      .first()
    
    if (parseInt(count.cnt || 0, 10) === 0) {
      await db('physical_locations').where({ id: locationId }).del()
      logger.info(`Orphaned location ${locationId} deleted`)
    }
  } catch (err) {
    logger.error(`Failed to clean up location ${locationId}: ` + err.message)
  }
}

export async function listProfiles(req, res) {
  const { search, room, table, box } = req.query
  let query = db('profiles')
    .leftJoin('physical_locations', 'profiles.physical_location_id', 'physical_locations.id')
    .select(
      'profiles.*',
      'physical_locations.room',
      'physical_locations.table_name',
      'physical_locations.box_number',
      db.raw("concat(physical_locations.room, ' / ', physical_locations.table_name, ' / ', physical_locations.box_number) as location_label")
    )
    .where('profiles.branch_id', req.session.branchId || 1)

  if (search) {
    query = query.where(function () {
      this.where('profiles.full_name', 'ilike', `%${search}%`)
        .orWhere('profiles.phone_number', 'ilike', `%${search}%`)
        .orWhere('profiles.passport_number', 'ilike', `%${search}%`)
    })
  }

  if (room) {
    query = query.where('physical_locations.room', 'ilike', `%${room}%`)
  }
  if (table) {
    query = query.where('physical_locations.table_name', 'ilike', `%${table}%`)
  }
  if (box) {
    query = query.where('physical_locations.box_number', 'ilike', `%${box}%`)
  }

  const profiles = await query.orderBy('profiles.updated_at', 'desc')
  res.json(profiles)
}

export async function createProfile(req, res) {
  const {
    full_name,
    phone_number,
    national_id,
    passport_number,
    status,
    physical_location_id,
    room,
    table_name,
    box_number,
    employee_name,
  } = req.body

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'Full name and phone number are required' })
  }

  const existing = await db('profiles').where({ phone_number }).first()
  if (existing) {
    return res.status(409).json({ error: 'DUPLICATE_PHONE', existingProfile: existing })
  }

  let locationId = null
  if (physical_location_id) {
    const loc = await db('physical_locations').where({ id: physical_location_id }).first()
    if (loc) {
      locationId = loc.id
    }
  } else if (room && table_name && box_number) {
    let loc = await db('physical_locations')
      .where({ room, table_name, box_number, branch_id: req.session.branchId || 1 })
      .first()
    if (!loc) {
      [loc] = await db('physical_locations')
        .insert({ room, table_name, box_number, branch_id: req.session.branchId || 1 })
        .returning('*')
    }
    locationId = loc.id
  }

  const creatorName = employee_name || (await resolveCreatorName(req)) || 'System'

  const [newProfile] = await db('profiles')
    .insert({
      full_name,
      phone_number,
      national_id,
      passport_number,
      status: status || 'pending',
      physical_location_id: locationId,
      branch_id: req.session.branchId || 1,
      created_by: creatorName,
    })
    .returning('*')

  // Auto-create permanent fields for the profile
  await createPermanentFields(newProfile.id, creatorName)

  await logActivity(sessionUserId(req), 'create', 'profile', newProfile.id, {
    full_name,
  })

  res.status(201).json(newProfile)
}

export async function getProfile(req, res) {
  const { id } = req.params
  const profile = await db('profiles')
    .leftJoin('physical_locations', 'profiles.physical_location_id', 'physical_locations.id')
    .select(
      'profiles.*',
      'physical_locations.room',
      'physical_locations.table_name',
      'physical_locations.box_number',
      db.raw("concat(physical_locations.room, ' / ', physical_locations.table_name, ' / ', physical_locations.box_number) as location_label")
    )
    .where('profiles.id', id)
    .first()

  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  const fields = await db('profile_fields')
    .leftJoin('files', 'profile_fields.id', 'files.profile_field_id')
    .where('profile_fields.profile_id', id)
    .select(
      'profile_fields.*',
      'files.id as file_id',
      'files.original_filename',
      'files.thumbnail_path',
      'files.stored_path',
      'files.mime_type'
    )

  const fieldsWithFiles = fields.reduce((acc, row) => {
    let field = acc.find((f) => f.id === row.id)
    if (!field) {
      field = { ...row, files: [] }
      delete field.file_id
      delete field.original_filename
      delete field.thumbnail_path
      delete field.stored_path
      delete field.mime_type
      acc.push(field)
    }
    if (row.file_id) {
      field.files.push({
        id: row.file_id,
        original_filename: row.original_filename,
        thumbnail_path: row.thumbnail_path,
        stored_path: row.stored_path,
        mime_type: row.mime_type,
      })
    }
    return acc
  }, [])

  res.json({ ...profile, fields: fieldsWithFiles })
}

export async function updateProfile(req, res) {
  const { id } = req.params
  const profile = await db('profiles').where({ id }).first()
  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  const oldLocationId = profile.physical_location_id

  const {
    full_name,
    phone_number,
    national_id,
    passport_number,
    status,
    physical_location_id,
    room,
    table_name,
    box_number,
  } = req.body

  if (!full_name || !phone_number) {
    return res.status(400).json({ error: 'Full name and phone number are required' })
  }

  if (phone_number) {
    const conflict = await db('profiles').where({ phone_number }).whereNot({ id }).first()
    if (conflict) {
      return res.status(409).json({ error: 'Phone number already in use by another profile' })
    }
  }

  let locationId = null
  if (physical_location_id) {
    const loc = await db('physical_locations').where({ id: physical_location_id }).first()
    if (loc) {
      locationId = loc.id
    }
  } else if (room && table_name && box_number) {
    let loc = await db('physical_locations')
      .where({ room, table_name, box_number, branch_id: req.session.branchId || 1 })
      .first()
    if (!loc) {
      [loc] = await db('physical_locations')
        .insert({ room, table_name, box_number, branch_id: req.session.branchId || 1 })
        .returning('*')
    }
    locationId = loc.id
  }

  const updates = {
    full_name,
    phone_number,
    national_id,
    passport_number,
    status,
    physical_location_id: locationId,
    updated_at: db.fn.now(),
    editing_started_at: null,
  }

  await db('profiles').where({ id }).update(updates)
  await logActivity(sessionUserId(req), 'update', 'profile', id, {
    changes: Object.keys(updates),
  })

  // Clean up old physical location if it changed and is no longer used
  if (oldLocationId && oldLocationId !== locationId) {
    await cleanupOrphanedLocation(oldLocationId)
  }

  const updated = await db('profiles').where({ id }).first()
  res.json(updated)
}

export async function startEditing(req, res) {
  const { id } = req.params
  await db('profiles').where({ id }).update({ editing_started_at: db.fn.now() })
  res.json({ message: 'Editing started' })
}

export async function deleteProfile(req, res) {
  const { id } = req.params
  const profile = await db('profiles').where({ id }).first()
  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  const locationId = profile.physical_location_id

  await db('profiles').where({ id }).del()
  await logActivity(sessionUserId(req), 'delete', 'profile', id, {})
  
  // Clean up physical location if no longer used anywhere else
  if (locationId) {
    await cleanupOrphanedLocation(locationId)
  }

  res.json({ message: 'Profile deleted' })
}

export async function uploadProfilePhoto(req, res) {
  const { id } = req.params
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' })
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowedTypes.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are allowed' })
  }

  if (req.file.size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Photo must be less than 5MB' })
  }

  try {
    const profile = await db('profiles').where({ id }).first()
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (profile.photo_path) {
      try {
        await fs.unlink(profile.photo_path)
      } catch (err) {
        // already gone
      }
    }

    const ext = path.extname(req.file.originalname)
    const filename = `${uuidv4()}${ext}`
    const filePath = path.join(PHOTO_DIR, filename)
    await fs.writeFile(filePath, req.file.buffer)

    await db('profiles').where({ id }).update({
      photo_path: filePath,
      updated_at: db.fn.now(),
    })

    await logActivity(sessionUserId(req), 'update', 'profile', id, {
      action: 'uploaded_photo',
    })

    res.json({
      message: 'Photo uploaded successfully',
      photo_url: `/api/profiles/${id}/photo`,
    })
  } catch (err) {
    logger.error('Photo upload error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to upload photo' })
  }
}

export async function getProfilePhoto(req, res) {
  const { id } = req.params
  try {
    const profile = await db('profiles').where({ id }).select('photo_path').first()
    if (!profile || !profile.photo_path) {
      return res.status(404).json({ error: 'No photo found' })
    }

    try {
      await fs.access(profile.photo_path)
    } catch {
      return res.status(404).json({ error: 'Photo file not found' })
    }

    const ext = path.extname(profile.photo_path).toLowerCase()
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    }
    const contentType = mimeTypes[ext] || 'image/jpeg'

    res.set('Cache-Control', 'private, max-age=3600')
    res.set('Content-Type', contentType)
        
    const fileBuffer = await fs.readFile(profile.photo_path)
    res.send(fileBuffer)
  } catch (err) {
    logger.error('Photo fetch error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to load photo' })
  }
}

export async function deleteProfilePhoto(req, res) {
  const { id } = req.params
  try {
    const profile = await db('profiles').where({ id }).select('photo_path').first()
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (profile.photo_path) {
      try {
        await fs.unlink(profile.photo_path)
      } catch (err) {
        // file already deleted
      }
    }

    await db('profiles').where({ id }).update({
      photo_path: null,
      updated_at: db.fn.now(),
    })

    await logActivity(sessionUserId(req), 'update', 'profile', id, {
      action: 'deleted_photo',
    })

    res.json({ message: 'Photo deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete photo' })
  }
}