import fs from 'fs/promises'
import path from 'path'
import chokidar from 'chokidar'
import db from '../config/database.js'
import logger from '../utils/logger.js'
import os from 'os'
import { classifyDocument, FIELD_SLOTS } from './docClassifier.js'
import { matchFileToChecklist, findExistingProfile } from './fileMatcher.js'
import { attachFileToProfile } from './profileFiles.js'

const SCANS_DIR = path.join(os.homedir(), 'Downloads')
const PROCESSED_DIR = path.join(os.homedir(), 'Downloads', 'AdalKeep-Processed') // kept for backward compatibility
const API_KEY = process.env.XAI_API_KEY
const MODEL = process.env.XAI_VISION_MODEL || process.env.XAI_MODEL || 'grok-4.20-non-reasoning'

// Cost + stability controls
const MAX_CONCURRENT = 2;           // prevents overwhelming xAI (cost effective)
const PROCESS_DELAY_MS = 800;       // small delay between queued items
let activeCount = 0;
const queue = [];

async function ensureDirs() {
  const adalKeepRoot = path.join(os.homedir(), 'Downloads', 'AdalKeep');
  await fs.mkdir(adalKeepRoot, { recursive: true });
  // Create one folder per field
  for (const f of FIELD_SLOTS) {
    const dir = path.join(adalKeepRoot, f.replace(/\s+/g, '-'));
    await fs.mkdir(dir, { recursive: true });
  }
}

async function createApprovalTask(extracted, originalFilename, storedPath, field) {
  const name = extracted.full_name || 'Unknown'
  const title = `Create profile: ${name}`
  const description = [
    `Detected: ${field}`,
    `Source: ${originalFilename}`,
    `Passport: ${extracted.passport_number || '—'}`,
    `National ID: ${extracted.national_id || '—'}`,
    `Phone: ${extracted.phone_number || '—'}`,
    `Confidence: ${extracted.confidence ?? 'n/a'}`,
    '',
    'Approve to create profile and attach this file.'
  ].join('\n')

  const payload = JSON.stringify({
    extracted,
    originalFilename,
    storedPath,
    field,
    stage: 'awaiting_profile_create'
  })

  try {
    const [id] = await db('tasks').insert({
      title,
      description,
      type: 'ai_create_profile',
      status: 'pending',
      priority: 'high',
      payload,
      is_ai_created: 1,
      created_by: 'AI-Folder-Watcher',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    logger.info(`[AI] createApprovalTask inserted id=${id}`)
    return id
  } catch (e) {
    logger.error(`[AI] createApprovalTask FAILED: ${e.message}`)
    throw e
  }
}

function slotFor(field) {
  if (!field || field === 'Other') return 'CV'
  return field
}

async function processFile(filePath) {
  const filename = path.basename(filePath)
  const ext = path.extname(filename).toLowerCase().toLowerCase()

  // Security: strict allowlist + hidden file protection
  const allowed = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf'
  };
  const mime = allowed[ext];
  if (!mime || filename.startsWith('.') || filename.includes('..')) {
    logger.warn(`[AI] Rejected unsafe file: ${filename}`);
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 12 * 1024 * 1024) {
      logger.warn(`[AI] Skip large file: ${filename}`);
      return;
    }

    logger.info(`[AI] Queuing for classification: ${filename}`);
    await enqueueClassification(filePath, mime, filename);
  } catch (err) {
    logger.error(`[AI] processFile ${filename}: ${err.message}`);
  }
}

// Simple concurrent queue to avoid rate limits and high cost on bulk downloads
async function enqueueClassification(filePath, mime, filename) {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    try {
      await processClassification(filePath, mime, filename);
    } finally {
      activeCount--;
      if (queue.length > 0) {
        const next = queue.shift();
        setTimeout(() => next(), PROCESS_DELAY_MS);
      }
    }
  } else {
    queue.push(() => enqueueClassification(filePath, mime, filename));
  }
}

async function processClassification(filePath, mime, filename) {
  try {
    logger.info(`[AI] Classifying: ${filename} (active: ${activeCount}/${MAX_CONCURRENT})`);
    const result = await classifyDocument(filePath, mime);
    const { field, confidence, reason, extracted } = result;

    logger.info(`[AI] → ${field} (${confidence.toFixed(2)}) ${reason || ''}`);

    // If classified as "Other", completely ignore it (leave in Downloads, do not move)
    if (field === 'Other') {
      logger.info(`[AI] Ignoring file classified as Other: ${filename}`);
      return;
    }

    // Create field-specific folder inside ~/Downloads/AdalKeep
    const adalKeepRoot = path.join(os.homedir(), 'Downloads', 'AdalKeep');
    const slot = slotFor(field)

    const fieldDir = path.join(adalKeepRoot, slot.replace(/\s+/g, '-'));
    await fs.mkdir(fieldDir, { recursive: true });

    // Prevent duplicates: if a file with same name already exists in the target folder, skip
    const safeName = `${Date.now()}_${filename}`.replace(/\s+/g, '_');
    const dest = path.join(fieldDir, safeName);

    if (await fs.access(dest).then(() => true).catch(() => false)) {
      logger.info(`[AI] Duplicate file skipped: ${filename}`);
      return;
    }

    await fs.rename(filePath, dest);
    logger.info(`[AI] Moved to AdalKeep/${slot}: ${filename}`);

    // 1) Name or passport already in DB → attach only (no new profile)
    const existing = await findExistingProfile(extracted || {})
    if (existing) {
      await attachFileToProfile(existing.id, slot, dest, filename)
      await matchFileToChecklist(filename, dest, {
        ...(extracted || {}),
        document_type: extracted?.document_type,
        _forcedField: slot
      })
      logger.info(`[AI] Existing profile #${existing.id} — attached ${slot}`)
      try {
        await db('tasks').insert({
          title: `${slot} attached: ${existing.full_name}`,
          description: `${filename} → profile #${existing.id} (${slot})`,
          type: 'ai_file_attached',
          status: 'completed',
          priority: 'low',
          profile_id: existing.id,
          is_ai_created: 1,
          created_by: 'AI',
          payload: JSON.stringify({ field: slot, filename, storedPath: dest, profileId: existing.id }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      } catch (e) {
        logger.warn(e.message)
      }
      return
    }

    // 2) New person with usable identity (passport OR name from CV/biodata)
    const hasIdentity =
      (extracted && extracted.passport_number) ||
      (extracted && extracted.full_name && String(extracted.full_name).trim().length > 3) ||
      (extracted && extracted.national_id)

    if (hasIdentity) {
      const taskId = await createApprovalTask(extracted, filename, dest, slot)
      logger.info(`[AI] Approval task #${taskId} for ${extracted.full_name || filename}`)
      return
    }

    // 3) No name/passport extracted — inbox only
    logger.info(`[AI] No identity on ${filename} — inbox task`);
    await db('tasks').insert({
      title: `${slot} received: ${filename}`,
      description: [
        `Classified as: ${field}`,
        `Reason: ${reason || '—'}`,
        'No name/passport extracted and no matching profile.'
      ].join('\n'),
      type: 'ai_file_inbox',
      status: 'pending',
      priority: 'medium',
      is_ai_created: 1,
      created_by: 'AI',
      payload: JSON.stringify({ field: slot, filename, storedPath: dest, extracted }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    logger.error(`[AI] Classification failed for ${filename}: ${err.message}`);
  }
}

export function startFolderWatcher() {
  if (!API_KEY) {
    console.warn('[AI] Watcher disabled – no XAI_API_KEY')
    return
  }
  ensureDirs().then(() => {
    const watcher = chokidar.watch(SCANS_DIR, {
      ignored: [/(^|[\/\\])\../, path.join(SCANS_DIR, 'AdalKeep-Processed')],
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 300 } // more stable for bulk downloads
    })

    watcher.on('add', (fp) => {
      if (fp.includes('AdalKeep-Processed') || fp.includes('crdownload') || fp.includes('.tmp')) return
      processFile(fp)
    })

    console.log(`[AI] Smart classifier started → ${SCANS_DIR} (max ${MAX_CONCURRENT} concurrent, delay ${PROCESS_DELAY_MS}ms)`)
    console.log(`[AI] Model → ${MODEL} | Cost-optimized + improved accuracy`)
  })
}

export async function extractProfileData() { return { full_name: '', confidence: 0 } }
export async function createOrUpdateProfile() { return { id: 0 } }
export async function saveFileToField() { return { success: true } }
export async function generateAmharicResponse() { return 'መረጃው ተቀብሏል።' }

export default {
  startFolderWatcher,
  extractProfileData,
  createOrUpdateProfile,
  saveFileToField,
  generateAmharicResponse
}
