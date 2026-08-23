import messagingRouter from './src/routes/messaging.js'
import subscriptionRouter from './src/routes/subscription.js'
import express from 'express'
import cors from 'cors'
import knex from 'knex'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { exec } from 'child_process'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import cron from 'node-cron'
import knexConfig from './knexfile.js'
import filesRouter from './src/routes/files.js'
import { generateFingerprint } from './src/services/fingerprints.js'
import { licenseLockMiddleware } from './src/middleware/licenseLock.js'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import aiRouter from './src/routes/ai.js'
import tasksRouter from './src/routes/tasks.js'
import updatesRouter from './src/routes/updates.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.join(__dirname, '.env')

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000

// Initialize Knex with configuration
const db = knex(knexConfig.development)

// Store db in app.locals for routes to access
app.locals.db = db

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

// Serve frontend static files
const frontendPath = path.join(__dirname, "..", "frontend")
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath))
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"))
  })
}

// Security headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
app.use('/api/subscription', subscriptionRouter)
app.use('/api/messaging', messagingRouter)

// Rate limit AI endpoints (20 requests per minute per IP)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'በጣም ብዙ ጥያቄዎች። እባክዎ ከ1 ደቂቃ በኋላ ይሞክሩ።' },
  standardHeaders: true,
  legacyHeaders: false
})

// Apply to AI routes only
app.use('/api/ai', aiLimiter)

// AI Routes
app.use('/api/ai', aiRouter)

// Tasks Routes
app.use('/api/tasks', tasksRouter)

// Updates Routes
app.use('/api/updates', updatesRouter)

// Utility function to safely check/add missing columns
async function ensureColumn(table, column, addFn) {
  const has = await db.schema.hasColumn(table, column)
  if (!has) await db.schema.table(table, addFn)
}

// 1. Initialize Database & License Verification on Startup
async function initSystem() {
  try {
    // Run migrations dynamically
    await db.migrate.latest()
    console.log('✅ Database migrations up to date')

    // Handle initial schema checks/updates for Profiles & Brokers
    const hasProfiles = await db.schema.hasTable('profiles')
    if (!hasProfiles) {
      await db.schema.createTable('profiles', (table) => {
        table.increments('id').primary()
        table.string('full_name')
        table.string('phone_number')
        table.string('national_id')
        table.string('passport_number')
        table.string('status').defaultTo('pending')
        table.integer('broker_id').nullable()
        table.string('notes')
        table.string('room')
        table.string('table_name')
        table.string('box_number')
        table.timestamps(true, true)
      })
    } else {
      await ensureColumn('profiles', 'broker_id', (t) => t.integer('broker_id').nullable())
      await ensureColumn('profiles', 'notes', (t) => t.string('notes'))
      await ensureColumn('profiles', 'room', (t) => t.string('room'))
      await ensureColumn('profiles', 'table_name', (t) => t.string('table_name'))
      await ensureColumn('profiles', 'box_number', (t) => t.string('box_number'))
    }

    const hasBrokers = await db.schema.hasTable('brokers')
    if (!hasBrokers) {
      await db.schema.createTable('brokers', (table) => {
        table.increments('id').primary()
        table.string('name')
        table.string('address')
        table.string('contact1')
        table.string('contact2')
        table.string('notes')
        table.timestamps(true, true)
      })
    } else {
      await ensureColumn('brokers', 'contact2', (t) => t.string('contact2'))
      await ensureColumn('brokers', 'notes', (t) => t.string('notes'))
    }

    // Verify License & Hardware Fingerprint
    const currentFingerprint = generateFingerprint()
    const licenseRecord = await db('license').first()

    if (!licenseRecord) {
      const defaultDevHash = await bcrypt.hash('759126348', 10)
      await db('license').insert({
        fingerprint: currentFingerprint,
        dev_password_hash: defaultDevHash,
      })
      app.locals.licenseLocked = false
      console.log('✅ License initialized and locked to this machine.')
    } else if (licenseRecord.fingerprint !== currentFingerprint) {
      app.locals.licenseLocked = true
      console.log('⚠️ HARDWARE MISMATCH! Server is LOCKED.')
    } else {
      app.locals.licenseLocked = false
      console.log('✅ License verified. Hardware matches.')
    }
  } catch (err) {
    console.error('❌ System initialization failed:', err)
    process.exit(1)
  }
}

// 2. Apply License Lock Middleware BEFORE core routes
app.use(licenseLockMiddleware)

// Helper function to filter object keys
function pick(obj, keys) {
  const out = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key]
    }
  }
  return out
}

// 3. Unlocked License Management Endpoints
app.post('/api/license/reset', async (req, res) => {
  try {
    const { devPassword } = req.body
    const licenseRecord = await db('license').first()

    if (!licenseRecord) return res.status(500).json({ error: 'License not initialized' })

    const isValid = await bcrypt.compare(devPassword, licenseRecord.dev_password_hash)
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid developer password' })
    }

    const currentFingerprint = generateFingerprint()
    await db('license').update({ fingerprint: currentFingerprint })
    app.locals.licenseLocked = false

    res.json({ success: true, message: 'Hardware fingerprint updated. Server unlocked.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to reset license' })
  }
})

app.get('/api/license/status', (req, res) => {
  res.json({ locked: req.app.locals.licenseLocked })
})

// 4. Core Application Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/dashboard', async (req, res) => {
  try {
    const profiles = await db('profiles').count('id as count').first()
    const brokers = await db('brokers').count('id as count').first()
    const byStatus = await db('profiles')
      .select('status')
      .count('id as count')
      .groupBy('status')

    const statusCounts = { pending: 0, in_progress: 0, completed: 0 }
    for (const row of byStatus) {
      const key = row.status || 'pending'
      statusCounts[key] = Number(row.count) || 0
    }

    const recent = await db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select(
        'profiles.id',
        'profiles.full_name',
        'profiles.phone_number',
        'profiles.status',
        'profiles.created_at',
        'brokers.name as broker_name'
      )
      .orderBy('profiles.created_at', 'desc')
      .limit(5)

    res.json({
      totalProfiles: Number(profiles?.count) || 0,
      totalBrokers: Number(brokers?.count) || 0,
      statusCounts,
      recent,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})

app.get('/api/profiles', async (req, res) => {
  try {
    const { q, status, broker_id } = req.query
    let query = db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select('profiles.*', 'brokers.name as broker_name')
      .orderBy('profiles.created_at', 'desc')

    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      query = query.where(function () {
        this.where('profiles.full_name', 'like', term)
          .orWhere('profiles.phone_number', 'like', term)
          .orWhere('profiles.national_id', 'like', term)
          .orWhere('profiles.passport_number', 'like', term)
      })
    }

    if (status && status !== 'all') {
      query = query.where('profiles.status', status)
    }

    if (broker_id) {
      query = query.where('profiles.broker_id', broker_id)
    }

    res.json(await query)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load profiles' })
  }
})

app.get('/api/profiles/:id', async (req, res) => {
  try {
    const profile = await db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select('profiles.*', 'brokers.name as broker_name')
      .where('profiles.id', req.params.id)
      .first()

    if (!profile) return res.status(404).json({ error: 'Not found' })
    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load profile' })
  }
})

app.post('/api/profiles', async (req, res) => {
  try {
    const data = pick(req.body, [
      'full_name',
      'phone_number',
      'national_id',
      'passport_number',
      'status',
      'broker_id',
      'notes',
      'room',
      'table_name',
      'box_number',
    ])

    if (!data.full_name?.trim() || !data.phone_number?.trim()) {
      return res.status(400).json({ error: 'Full name and phone are required' })
    }

    data.status = data.status || 'pending'
    if (data.broker_id === '' || data.broker_id === null) data.broker_id = null
    else if (data.broker_id !== undefined) data.broker_id = Number(data.broker_id)

    const [id] = await db('profiles').insert(data)
    const profile = await db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select('profiles.*', 'brokers.name as broker_name')
      .where('profiles.id', id)
      .first()

    res.status(201).json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create profile' })
  }
})

app.put('/api/profiles/:id', async (req, res) => {
  try {
    const existing = await db('profiles').where('id', req.params.id).first()
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const data = pick(req.body, [
      'full_name',
      'phone_number',
      'national_id',
      'passport_number',
      'status',
      'broker_id',
      'notes',
      'room',
      'table_name',
      'box_number',
    ])

    if (data.full_name !== undefined && !String(data.full_name).trim()) {
      return res.status(400).json({ error: 'Full name is required' })
    }
    if (data.phone_number !== undefined && !String(data.phone_number).trim()) {
      return res.status(400).json({ error: 'Phone is required' })
    }

    if (data.broker_id === '' || data.broker_id === null) data.broker_id = null
    else if (data.broker_id !== undefined) data.broker_id = Number(data.broker_id)

    data.updated_at = new Date().toISOString()
    await db('profiles').where('id', req.params.id).update(data)

    const profile = await db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select('profiles.*', 'brokers.name as broker_name')
      .where('profiles.id', req.params.id)
      .first()

    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update profile' })
  }
})

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const deleted = await db('profiles').where('id', req.params.id).del()
    if (!deleted) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete profile' })
  }
})

app.get('/api/brokers', async (req, res) => {
  try {
    const { q } = req.query
    let query = db('brokers').select('brokers.*').orderBy('brokers.name')

    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      query = query.where(function () {
        this.where('name', 'like', term)
          .orWhere('address', 'like', term)
          .orWhere('contact1', 'like', term)
          .orWhere('contact2', 'like', term)
      })
    }

    const brokers = await query
    const counts = await db('profiles')
      .select('broker_id')
      .count('id as count')
      .whereNotNull('broker_id')
      .groupBy('broker_id')

    const countMap = Object.fromEntries(
      counts.map((r) => [String(r.broker_id), Number(r.count) || 0])
    )

    res.json(
      brokers.map((b) => ({
        ...b,
        profile_count: countMap[String(b.id)] || 0,
      }))
    )
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load brokers' })
  }
})

app.get('/api/brokers/:id', async (req, res) => {
  try {
    const broker = await db('brokers').where('id', req.params.id).first()
    if (!broker) return res.status(404).json({ error: 'Not found' })

    const profile_count = await db('profiles')
      .where('broker_id', broker.id)
      .count('id as count')
      .first()

    res.json({
      ...broker,
      profile_count: Number(profile_count?.count) || 0,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load broker' })
  }
})

app.post('/api/brokers', async (req, res) => {
  try {
    const data = pick(req.body, ['name', 'address', 'contact1', 'contact2', 'notes'])
    if (!data.name?.trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }

    const [id] = await db('brokers').insert(data)
    const broker = await db('brokers').where('id', id).first()
    res.status(201).json({ ...broker, profile_count: 0 })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create broker' })
  }
})

app.put('/api/brokers/:id', async (req, res) => {
  try {
    const existing = await db('brokers').where('id', req.params.id).first()
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const data = pick(req.body, ['name', 'address', 'contact1', 'contact2', 'notes'])
    if (data.name !== undefined && !String(data.name).trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }

    data.updated_at = new Date().toISOString()
    await db('brokers').where('id', req.params.id).update(data)

    const broker = await db('brokers').where('id', req.params.id).first()
    const profile_count = await db('profiles')
      .where('broker_id', broker.id)
      .count('id as count')
      .first()

    res.json({
      ...broker,
      profile_count: Number(profile_count?.count) || 0,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update broker' })
  }
})

app.delete('/api/brokers/:id', async (req, res) => {
  try {
    const linked = await db('profiles').where('broker_id', req.params.id).count('id as count').first()
    if (Number(linked?.count) > 0) {
      await db('profiles').where('broker_id', req.params.id).update({ broker_id: null })
    }

    const deleted = await db('brokers').where('id', req.params.id).del()
    if (!deleted) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete broker' })
  }
})

// Fetch & auto-create permanent profile fields
app.get('/api/profiles/:id/fields', async (req, res) => {
  try {
    const { id } = req.params
    const database = req.app.locals.db

    const templates = await database('field_templates').where('is_permanent', true).orderBy('id')

    const result = []
    for (const template of templates) {
      let field = await database('profile_fields')
        .where('profile_id', id)
        .andWhere('name', template.name)
        .first()

      if (!field) {
        const [newFieldId] = await database('profile_fields').insert({
          profile_id: id,
          field_template_id: template.id,
          name: template.name,
          data_type: template.data_type,
          is_permanent: true,
        })
        field = { id: newFieldId, name: template.name, data_type: template.data_type, is_permanent: true }
      }

      const files = await database('files')
        .where('profile_field_id', field.id)
        .select('id', 'original_name', 'path', 'mimetype', 'size')

      result.push({ ...field, files })
    }

    res.json(result)
  } catch (err) {
    console.error('Fields error:', err)
    res.status(500).json({ error: 'Failed to load profile fields' })
  }
})

// File upload routes
app.use('/api', filesRouter)

// Checklist route for bulk status resolution
app.get('/api/checklist', async (req, res) => {
  try {
    const database = req.app.locals.db

    // Get basic profile info
    const profiles = await database('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select(
        'profiles.id',
        'profiles.full_name',
        'profiles.phone_number',
        'profiles.status',
        'profiles.national_id',
        'profiles.passport_number',
        'brokers.name as broker_name'
      )
      .orderBy('profiles.created_at', 'desc')

    const result = []
    for (const p of profiles) {
      // Get field statuses (true if file exists, false otherwise)
      const fields = await database('profile_fields')
        .leftJoin('files', 'profile_fields.id', 'files.profile_field_id')
        .where('profile_fields.profile_id', p.id)
        .select('profile_fields.name', 'files.id as file_id')

      const fieldStatus = {}
      fields.forEach((f) => {
        fieldStatus[f.name] = !!f.file_id // true if file_id exists
      })

      result.push({ ...p, fieldStatus })
    }

    res.json(result)
  } catch (err) {
    console.error('Checklist error:', err)
    res.status(500).json({ error: 'Failed to load checklist' })
  }
})

// 1. Get all checklists with their profiles
app.get('/api/checklists', async (req, res) => {
  try {
    const db = req.app.locals.db
    const checklists = await db('checklists').orderBy('created_at', 'desc')
    const result = []
    
    for (const c of checklists) {
      const profiles = await db('checklist_profiles')
        .join('profiles', 'checklist_profiles.profile_id', 'profiles.id')
        .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
        .where('checklist_id', c.id)
        .select('profiles.*', 'brokers.name as broker_name')
      result.push({ ...c, profiles })
    }
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load checklists' })
  }
})

// 2. Create a new checklist
app.post('/api/checklists', async (req, res) => {
  try {
    const { name } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    const [id] = await req.app.locals.db('checklists').insert({ name })
    res.status(201).json({ id, name, profiles: [] })
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checklist' })
  }
})

// 3. Delete a checklist
app.delete('/api/checklists/:id', async (req, res) => {
  try {
    await req.app.locals.db('checklist_profiles').where('checklist_id', req.params.id).del()
    await req.app.locals.db('checklists').where('id', req.params.id).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete checklist' })
  }
})

// 4. Add profile to checklist
app.post('/api/checklists/:id/profiles', async (req, res) => {
  try {
    const { profile_id } = req.body
    const exists = await req.app.locals.db('checklist_profiles')
      .where({ checklist_id: req.params.id, profile_id })
      .first()
    
    if (!exists) {
      await req.app.locals.db('checklist_profiles').insert({ checklist_id: req.params.id, profile_id })
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to add profile' })
  }
})

// 5. Remove profile from checklist (Does NOT delete the profile itself)
app.delete('/api/checklists/:id/profiles/:profileId', async (req, res) => {
  try {
    await req.app.locals.db('checklist_profiles')
      .where({ checklist_id: req.params.id, profile_id: req.params.profileId })
      .del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove profile' })
  }
})

// Ensure public directory exists for wallpaper
if (!fs.existsSync('./public')) {
  fs.mkdirSync('./public')
}

// Configure multer specifically for the wallpaper
const wallpaperStorage = multer.diskStorage({
  destination: './public',
  filename: (req, file, cb) => cb(null, 'wallpaper.jpg') // Always overwrite as wallpaper.jpg
})
const uploadWallpaper = multer({ 
  storage: wallpaperStorage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
})

// Upload Wallpaper
app.post('/api/settings/wallpaper', uploadWallpaper.single('wallpaper'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ success: true, url: '/api/wallpaper' })
})

// Serve Wallpaper
app.get('/api/wallpaper', (req, res) => {
  const filePath = path.resolve('./public/wallpaper.jpg')
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.status(404).json({ error: 'No wallpaper set' })
  }
})

// Remove Wallpaper
app.delete('/api/settings/wallpaper', (req, res) => {
  const filePath = path.resolve('./public/wallpaper.jpg')
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  res.json({ success: true })
})

// Save Host/Port Settings to .env
app.post('/api/settings', (req, res) => {
  try {
    const { host, port } = req.body

    // 1. Read existing .env or start with empty string if it doesn't exist
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

    const lines = envContent.split('\n').filter((line) => line.trim() !== '')
    let hostUpdated = false
    let portUpdated = false

    const newLines = lines.map((line) => {
      if (line.startsWith('HOST=')) {
        hostUpdated = true
        return `HOST=${host}`
      }
      if (line.startsWith('PORT=')) {
        portUpdated = true
        return `PORT=${port}`
      }
      return line
    })

    if (!hostUpdated) newLines.push(`HOST=${host}`)
    if (!portUpdated) newLines.push(`PORT=${port}`)

    // 2. Write back to .env
    fs.writeFileSync(envPath, newLines.join('\n') + '\n', 'utf8')

    res.json({
      success: true,
      message: 'Settings saved. Restart backend to apply network changes.',
    })
  } catch (err) {
    console.error('❌ SETTINGS SAVE ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

// Check for Updates and Pull from GitHub
app.post('/api/system/update', (req, res) => {
  // The root directory is one level up from backend/src (or backend directory)
  const rootDir = path.join(__dirname, '..')
  
  exec('git pull', { cwd: rootDir }, (error, stdout, stderr) => {
    if (error) {
      console.error('Update error:', error)
      return res.status(500).json({ error: stderr || error.message })
    }
    
    if (stdout.includes('Already up to date.')) {
      return res.json({ success: true, message: 'System is already up to date!' })
    }
    
    res.json({ 
      success: true, 
      message: 'Update successful! Please restart the backend server to apply changes.' 
    })
  })
})

// Global error handler (add AFTER all routes, BEFORE app.listen)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'ውስጣዊ ስህተት ተፈጥሯል'
      : err.message
  })
})

// Auto-delete completed tasks older than 7 days
cron.schedule('0 2 * * *', async () => { // Runs daily at 2 AM
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const deleted = await db('tasks')
      .where('status', 'done')
      .andWhere('updated_at', '<', cutoff)
      .del()
    if (deleted > 0) {
      console.log(`🗑️ Auto-deleted ${deleted} completed tasks older than 7 days`)
    }
  } catch (err) {
    console.error('Auto-delete failed:', err.message)
  }
})

// Mark AIs as offline if no heartbeat in 5 minutes
cron.schedule('* * * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    await db('ai_instances')
      .where('last_seen', '<', cutoff)
      .andWhere('is_online', true)
      .update({ is_online: false })
  } catch {}
})

// 5. Start Server
initSystem().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`)
  })
})