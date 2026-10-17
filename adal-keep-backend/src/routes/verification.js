/**
 * routes/verification.js — the 3-green-tick gate, the server identity
 * endpoint an Employee PC uses to find this machine, and the one endpoint
 * the tray Companion posts watched files to.
 */

import express from 'express'
import path from 'path'
import fs from 'fs'
import { upload, generateThumbnail, getRelativePath } from '../services/storage.js'
import {
  TICKS,
  POLICE_WORKFLOW_DOCS,
  ensureVerificationSchema,
  runPassportVerification,
  getProfileVerification,
  assertPoliceReady,
} from '../services/verification.js'
import { getLanAddresses, getPrimaryLanAddress, DISCOVERY_PORT } from '../services/discovery.js'

const router = express.Router()

/** Which company is this machine running? Used for the tray tooltip. */
async function companyName(handle) {
  try {
    const c = await handle('companies').first()
    return c?.name || 'Adal Keep'
  } catch {
    return 'Adal Keep'
  }
}

/** GET /api/profiles/:profileId/verification — cached ticks, never runs OCR. */
router.get('/profiles/:profileId/verification', async (req, res) => {
  try {
    const out = await getProfileVerification(Number(req.params.profileId), {
      handle: req.app.locals.db,
    })
    res.json({ ...out, tick_definitions: TICKS, required_documents: POLICE_WORKFLOW_DOCS })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** POST /api/profiles/:profileId/verification/run — the "Re-check" button. */
router.post('/profiles/:profileId/verification/run', async (req, res) => {
  try {
    const out = await runPassportVerification(Number(req.params.profileId), {
      handle: req.app.locals.db,
    })
    res.json({ ...out, tick_definitions: TICKS, required_documents: POLICE_WORKFLOW_DOCS })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** GET /api/profiles/:profileId/verification/gate — cheap automation preflight. */
router.get('/profiles/:profileId/verification/gate', async (req, res) => {
  try {
    res.json(await assertPoliceReady(Number(req.params.profileId), { handle: req.app.locals.db }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ==========================================================================
   COMPANION — how an Employee PC talks to this machine
   ========================================================================== */

/**
 * GET /api/companion/info
 * Deliberately reachable with no session: the tray app calls it the moment it
 * starts, before anything is logged in, and a 401 here would make every
 * workstation look "offline". It leaks no personal data — only the fact that
 * an Adal Keep server lives on this LAN.
 */
router.get('/companion/info', async (req, res) => {
  try {
    const handle = req.app.locals.db
    const name = await companyName(handle)
    res.json({
      service: 'adal-keep',
      role: 'server',
      name,
      api_key_name: `Adal ${name}`,
      port: Number(process.env.PORT || 4000),
      discovery_port: DISCOVERY_PORT,
      lan_addresses: getLanAddresses(),
      primary_address: getPrimaryLanAddress(),
      uptime_seconds: Math.round(process.uptime()),
      version: process.env.ADAL_VERSION || '1.0.0',
      time: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/companion/ingest
 *
 * The tray Companion on an Employee PC posts every file it finds in
 * `Downloads` (and anything dropped on the tray icon) here.
 *
 *   ?profile_id=123&field=Passport  → attached straight to that profile field
 *   (no profile_id)                 → parked in the shared file tray for an
 *                                     operator to assign by drag and drop
 *
 * When the target field is `Passport` the three green ticks are recomputed
 * immediately, so the operator sees them light up as the employee scans.
 */
router.post('/companion/ingest', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const handle = req.app.locals.db
  const clientId = req.get('x-adal-client') || req.body?.client_id || 'unknown-client'
  const profileId = Number(req.body?.profile_id || req.query?.profile_id)
  const field = String(req.body?.field || req.query?.field || 'Other').trim() || 'Other'

  try {
    if (!fs.existsSync(req.file.path)) {
      return res.status(500).json({ error: 'Upload was not stored' })
    }

    // ── Attach to a profile ────────────────────────────────────────────
    if (Number.isFinite(profileId) && profileId > 0) {
      const profile = await handle('profiles').where('id', profileId).first()
      if (!profile) return res.status(404).json({ error: `Profile ${profileId} not found` })

      const { attachFileToProfile } = await import('../services/profileFiles.js')
      const attached = await attachFileToProfile(
        profileId,
        field,
        req.file.path,
        req.file.originalname
      )

      let verification = null
      if (/^passport$/i.test(field)) {
        try {
          verification = await runPassportVerification(profileId, { handle })
        } catch (e) {
          console.warn('[companion] auto-verification failed:', e.message)
        }
      }

      return res.status(201).json({
        ok: true,
        mode: 'profile',
        client_id: clientId,
        profile_id: profileId,
        field,
        fileId: attached?.fileId || null,
        profileFieldId: attached?.profileFieldId || null,
        ticks_count: verification?.ticks_count ?? null,
        all_green: verification?.all_green ?? null,
        verification,
      })
    }

    // ── Park in the tray ──────────────────────────────────────────────
    if (req.file.mimetype?.startsWith('image/')) {
      const thumbPath = req.file.path.replace(/(\.\w+)$/, '_thumb$1')
      try { await generateThumbnail(req.file.path, thumbPath) } catch {}
    }

    const [fileId] = await handle('files').insert({
      profile_field_id: null,
      original_name: req.file.originalname,
      path: getRelativePath(req.file.path),
      mimetype: req.file.mimetype,
      size: req.file.size,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    console.log(
      `[companion] ${clientId} → tray: ${path.basename(req.file.originalname)} ` +
      `(${Math.round((req.file.size || 0) / 1024)} KB, file ${fileId})`
    )

    res.status(201).json({
      ok: true,
      mode: 'tray',
      client_id: clientId,
      fileId,
      original_name: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    })
  } catch (e) {
    console.error('[companion] ingest failed:', e)
    res.status(500).json({ error: e.message })
  }
})

export default router
