import paymentsRouter from './src/routes/payments.js'
import express from 'express'
import musanedAccountsRouter from './src/routes/musanedAccounts.js'
import cors from 'cors'
import knex from 'knex'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { exec } from 'child_process'
import helmet from 'helmet'
import cron from 'node-cron'
import knexConfig from './knexfile.js'
import filesRouter from './src/routes/files.js'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import tasksRouter from './src/routes/tasks.js'
import updatesRouter from './src/routes/updates.js'
import tutorRouter from './src/routes/tutor.js'
import systemUpdateRouter from './src/routes/systemUpdate.js'
import quickLinksRouter from "./src/routes/quickLinks.js"
import tenancyRouter, { attachAuth } from "./src/routes/tenancy.js"
import employeesRouter from "./src/routes/employees.js"
import employeeRegisterRouter from "./src/routes/employeeRegister.js"
import aiTasksRouter from "./src/routes/aiTasks.js"
import branchesRouter from "./src/routes/branches.js"
import { ensureTenancySchema, adoptOrphanData } from "./src/services/tenancy.js"
import { subscriptionGuard, statusPayload, maybeNotify } from "./src/services/subscription.js"
import authRouter from "./src/routes/auth.js"
import cvRouter from './src/routes/cv.js'
import automationsRouter from './src/routes/automations.js'
import lmisAccountsRouter from './src/routes/lmisAccounts.js'
import settingsRouter from './src/routes/settings.js'
import { startFolderWatcher } from "./src/services/aiIngestion.js"
import { startWorker } from './src/services/worker.js'
import { startScanner } from './src/services/autoScanner.js'
import verificationRouter from './src/routes/verification.js'
import newProfileRouter from './src/routes/newProfile.js'
import chatRouter, { watchPaid } from './src/routes/chat.js'
import trashRouter from './src/routes/trash.js'
import mainPCRouter from './src/routes/mainPC.js'
import branchMergeRouter from './src/routes/branchMerge.js'
import wafidRouter from './src/routes/wafid.js'
import backupRouter from './src/routes/backup.js'
import contractsRouter from './src/routes/contracts.js'
import { startContractChecker } from './src/services/musanedContracts.js'
import { startBackupSchedule, applyRestoredDatabase } from './src/services/telegramBackup.js'
import { startWafidChecker } from './src/services/wafidStatus.js'
import { isFollower, mainURL, instanceId } from './src/services/mainPC.js'
import { moveToTrash } from './src/services/trash.js'
import { startDiscoveryResponder } from './src/services/discovery.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.join(__dirname, '.env')

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000

// Initialize Knex with configuration
applyRestoredDatabase() // a database restored from the Telegram backup goes in first
const db = knex(knexConfig.development)

// Store db in app.locals for routes to access
app.locals.db = db

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

// Locked after the trial: every API call and stored document is refused.
app.use(subscriptionGuard)
// Serve uploaded SafeStorage files statically
app.use('/uploads', express.static(path.join(process.cwd(), 'data/SafeStorage')))

app.use(attachAuth)

// Core Feature Routes
app.use("/api", tenancyRouter)
app.use('/api/payments', paymentsRouter)
app.use("/api/employees", employeesRouter)
app.use("/api/employees", employeeRegisterRouter)
app.use("/api/tasks", tasksRouter)
app.use("/api/ai-tasks", aiTasksRouter)
app.use("/api/branches", branchesRouter)

// Security headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))

// NOTE: the frontend static files AND the SPA fallback are registered at the
// BOTTOM of this file on purpose. Express matches routes in registration
// order, so `app.get('*')` here would shadow every route defined below it —
// which silently broke /api/system/update/check, /api/subscription/status,
// /api/auth/me, /api/settings, /api/cv/*, /api/lmis/* and /api/musaned/*.

// Subscription & Management Routes

// Updates & System Routes
app.use('/api/updates', updatesRouter)
app.use('/api', tutorRouter)   // daily in-app tutor
app.use('/api/system', systemUpdateRouter)
app.use("/api/quick-links", quickLinksRouter)
app.use("/api/auth", authRouter)
app.use('/api/lmis', lmisAccountsRouter)
app.use('/api/musaned', musanedAccountsRouter)
app.use('/api/cv', cvRouter)
app.use('/api/settings', settingsRouter)
app.use('/api', automationsRouter)
// 3-green-tick verification gate + the LAN endpoints the Employee-PC Companion talks to
app.use('/api', verificationRouter)
app.use('/api', newProfileRouter)
app.use('/api', chatRouter)
app.use('/api', trashRouter)
app.use('/api', mainPCRouter)
app.use('/api', branchMergeRouter)
app.use('/api', wafidRouter)
app.use('/api', backupRouter)
app.use('/api', contractsRouter)
watchPaid(db)

// Utility function to safely check/add missing columns
async function ensureColumn(table, column, addFn) {
  const has = await db.schema.hasColumn(table, column)
  if (!has) await db.schema.table(table, addFn)
}

// 1. Initialize the database on startup
async function initSystem() {
  try {
    // Run migrations dynamically
    try {
      await db.migrate.latest()
      console.log('✅ Database migrations up to date')
      await ensureTenancySchema(db)
    } catch (migErr) {
      console.warn('⚠️ Migration check skipped or non-critical issue:', migErr.message)
    }

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
      await ensureColumn('brokers', 'created_by', (t) => t.integer('created_by'))
    }

    // The company-setup password (first run). Locking and paying are handled
    // by subscription.js; the old hardware-fingerprint lock is gone.
    if (!(await db('license').first())) {
      const defaultDevHash = await bcrypt.hash(process.env.DEV_MASTER_PASSWORD || '759126348', 10)
      await db('license').insert({ fingerprint: '', dev_password_hash: defaultDevHash })
    }
  } catch (err) {
    console.error('❌ System initialization failed:', err)
    process.exit(1)
  }
}

app.locals.runInit = initSystem
setInterval(async () => { try { await maybeNotify(app.locals.db, statusPayload()) } catch {} }, 3600000)

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

// 2. Core Application Routes
app.get('/api/health', (req, res) => {
  // role/instance let another PC check it is choosing a real main PC.
  res.json({ status: 'ok', role: isFollower() ? 'follower' : 'main', main_url: mainURL() || undefined, instance: instanceId() })
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
          .orWhere('profiles.labor_id', 'like', term)
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
      'middle_name',
      'order_id',
      'phone_number',
      'national_id',
      'passport_number',
      'status',
      'broker_id',
      'notes',
      'room',
      'table_name',
      'box_number',
      'religion',
      'marital_status',
      'children_count',
      'weight',
      'height',
      'complexion',
      'living_town',
      'mother_name',
      'father_name',
      'spouse_name',
      'education_level',
      'speaks_english',
      'speaks_arabic',
      'skills',
      'previous_employment',
      'work_experience',
      'experience_country',
      'experience_years',
      'region',
      'zone_subcity',
      'labor_id',
      'personal_number',
      'emergency_name',
      'emergency_phone',
      'emergency_gender',
      'emergency_relationship',
      'cooking_skill',
      'destination_country',
      'date_of_birth',
      'gender',
      'nationality',
      'place_of_birth',
      'passport_issue_date',
      'passport_expiry_date',
      'first_name',
      'last_name',
      'phone_number_2',
      'created_by',
    ])

    if (!data.full_name?.trim() || !data.phone_number?.trim()) {
      return res.status(400).json({ error: 'Full name and phone are required' })
    }

    data.status = data.status || 'pending'
    data.created_by = (data.created_by || '').toString().trim() || 'System'
    if (data.broker_id === '' || data.broker_id === null) data.broker_id = null
    else if (data.broker_id !== undefined) data.broker_id = Number(data.broker_id)

    const [id] = await db('profiles').insert(data)
    const profile = await db('profiles')
      .leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
      .select('profiles.*', 'brokers.name as broker_name')
      .where('profiles.id', id)
      .first()

    try {
      const { onProfileUpdated } = await import('./src/services/autoTrigger.js')
      await onProfileUpdated(db, id)
    } catch (e) {
      console.error('[profiles] autoTrigger after create:', e.message)
    }

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
      'middle_name',
      'order_id',
      'phone_number',
      'national_id',
      'passport_number',
      'status',
      'broker_id',
      'notes',
      'room',
      'table_name',
      'box_number',
      'religion',
      'marital_status',
      'children_count',
      'weight',
      'height',
      'complexion',
      'living_town',
      'mother_name',
      'father_name',
      'spouse_name',
      'education_level',
      'speaks_english',
      'speaks_arabic',
      'skills',
      'previous_employment',
      'work_experience',
      'experience_country',
      'experience_years',
      'region',
      'zone_subcity',
      'labor_id',
      'personal_number',
      'emergency_name',
      'emergency_phone',
      'emergency_gender',
      'emergency_relationship',
      'cooking_skill',
      'destination_country',
      'date_of_birth',
      'gender',
      'nationality',
      'place_of_birth',
      'passport_issue_date',
      'passport_expiry_date',
      'first_name',
      'last_name',
      'phone_number_2',
      // Visa & Contract (filled by the Musaned contract check, editable by hand)
      'musaned_stage', 'musaned_payment', 'musaned_pro', 'contract_number', 'visa_number', 'tawassut_number',
      'employer_name', 'employer_id', 'employer_phone', 'employer_address', 'work_city', 'salary',
      'contract_date', 'issuing_authority', 'job_title',
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

    // AUTO-TRIGGER HOOK
    try {
      const { onProfileUpdated } = await import('./src/services/autoTrigger.js')
      await onProfileUpdated(db, req.params.id)
    } catch (e) {
      console.error('[profiles] autoTrigger after update:', e.message)
    }

    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update profile' })
  }
})

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    // To the Trash (with its documents), restorable from the main PC.
    const deleted = await moveToTrash(db, 'profile', req.params.id, req)
    if (!deleted) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete profile' })
  }
})

app.post('/api/brokers/assign', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.body.profileId ?? req.body.profile_id)
    const brokerId = Number(req.body.brokerId ?? req.body.broker_id)
    if (!profileId || !brokerId) {
      return res.status(400).json({ error: 'profileId and brokerId required' })
    }
    await db('profiles').where({ id: profileId }).update({
      broker_id: brokerId,
      updated_at: db.fn.now()
    })
    res.json({ message: 'Assigned', profileId, brokerId })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/brokers/unassign', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.body.profileId ?? req.body.profile_id)
    if (!profileId) return res.status(400).json({ error: 'profileId required' })
    await db('profiles').where({ id: profileId }).update({ broker_id: null, updated_at: db.fn.now() })
    res.json({ message: 'Unassigned' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/brokers', async (req, res) => {
  try {
    const { q } = req.query
    let query = db('brokers').select('brokers.*').orderBy('brokers.name')
    const uid = req.session?.userId || req.auth?.userId
    const role = req.session?.role || req.auth?.role
    if (uid && role === 'employee') {
      query = query.where(function () {
        this.where('brokers.created_by', uid).orWhereNull('brokers.created_by')
      })
    }

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
    const data = pick(req.body, ['name', 'address', 'contact1', 'contact2', 'notes', 'created_by'])
    if (!data.name?.trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }

    data.created_by = (data.created_by || '').toString().trim() || null

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
    // To the Trash; its profiles are kept (and get the broker back on restore).
    const deleted = await moveToTrash(db, 'broker', req.params.id, req)
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

    const forcedFields = ['Photo', 'Self Video']
    for (const f of forcedFields) {
      const exists = templates.some(t => t.name === f)
      if (!exists) {
        const [newTpl] = await database('field_templates').insert({
          name: f,
          data_type: 'file',
          is_permanent: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).returning('*')
        templates.push(newTpl)
      }
    }

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
      const fields = await database('profile_fields')
        .leftJoin('files', 'profile_fields.id', 'files.profile_field_id')
        .where('profile_fields.profile_id', p.id)
        .select('profile_fields.name', 'files.id as file_id')

      const fieldStatus = {}
      fields.forEach((f) => {
        fieldStatus[f.name] = !!f.file_id
      })

      result.push({ ...p, fieldStatus })
    }

    res.json(result)
  } catch (err) {
    console.error('Checklist error:', err)
    res.status(500).json({ error: 'Failed to load checklist' })
  }
})

// Checklists management
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

app.delete('/api/checklists/:id', async (req, res) => {
  try {
    await moveToTrash(req.app.locals.db, 'checklist', req.params.id, req)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete checklist' })
  }
})

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

// Wallpaper routes
const wallpaperStorage = multer.diskStorage({
  destination: './public',
  filename: (req, file, cb) => cb(null, 'wallpaper.jpg')
})
const uploadWallpaper = multer({ 
  storage: wallpaperStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
})

app.post('/api/settings/wallpaper', uploadWallpaper.single('wallpaper'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ success: true, url: '/api/wallpaper' })
})

app.get('/api/wallpaper', (req, res) => {
  const filePath = path.resolve('./public/wallpaper.jpg')
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.status(404).json({ error: 'No wallpaper set' })
  }
})

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

// --- AI CHAT ENDPOINT ---
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'Message required' })

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSESTREAM_API_KEY || process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a helpful assistant for Adal, an Ethiopian employment agency CRM. Answer in Amharic or English as appropriate.' },
          { role: 'user', content: message }
        ],
        max_tokens: 500
      })
    })

    const data = await response.json()
    res.json({ reply: data.choices[0].message.content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// Frontend (SPA) hosting — MUST remain after every API route.
// ---------------------------------------------------------------------------
const FRONTEND_CANDIDATES = [
  path.join(__dirname, '..', 'adal-keep-frontend', 'dist'), // packaged + updater layout
  path.join(__dirname, '..', 'frontend'),                   // legacy layout
  path.join(__dirname, '..', 'adal-keep-frontend'),         // source fallback
]

function resolveFrontendDir() {
  return FRONTEND_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null
}

const frontendDir = process.env.FRONTEND_DIR || resolveFrontendDir()

if (frontendDir) {
  app.use(express.static(frontendDir))
  console.log(`🖥️  Serving UI from ${frontendDir}`)
} else {
  console.warn('⚠️  No built UI found — run "npm run build" inside adal-keep-frontend')
}

// Unmatched API calls must return JSON, never the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` })
})

// SPA fallback for every non-API path.
if (frontendDir) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'))
  })
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'ውስጣዊ ስህተት ተፈጥሯል'
      : err.message
  })
})

// Auto-delete completed tasks older than 7 days
cron.schedule('0 2 * * *', async () => {
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

// 5. Start Server
initSystem().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`)
    if (isFollower()) {
      // Another PC is the main PC: all work happens there, nothing here.
      console.log(`🔗 This PC follows the main PC at ${mainURL()} — no automations, no discovery here`)
      return
    }
    startFolderWatcher(db, 1)     // watches the inbox for new files
    startWorker(db)               // runs queued jobs, each in its own tab
    startScanner(db)              // discovers new work every 2 min
    startWafidChecker(db)         // Medical · Applied → Fit / Rejected from wafid.com
    startBackupSchedule(db)       // locked copy to Telegram in the lunch break
    startContractChecker(db)      // chosen by a Saudi employer? contract + PDFs from Musaned
    console.log('🤖 Automation: worker + scanner running')

    // Answer Employee PCs that broadcast "where is Adal Keep?" on the LAN.
    // Best-effort: a busy UDP port or a missing NIC never stops the server.
    startDiscoveryResponder({
      port: Number(process.env.DISCOVERY_PORT) || undefined,
      name: 'Adal Keep',
      getInfo: () => ({ port: Number(PORT) }),
    })
  })
})

// Auto-open Brave workspace
const AUTO_START_BRAVE = process.env.AUTO_START_BRAVE !== 'false' && !isFollower()
if (AUTO_START_BRAVE) {
  setTimeout(async () => {
    try {
      const { startAgent } = await import('./src/services/braveAgent.js')
      const r = await startAgent({ openPextran: false })
      console.log('[Brave]', r.ok ? r.message : r.error)
    } catch (e) {
      console.warn('[Brave] auto-start skipped:', e.message)
    }
  }, 2500)
}