import fs from 'fs'
import path from 'path'

const SETTLE_MS = 1000 // the watcher already waited for the file to stop changing
const MAX_ATTEMPTS = 5
const TICK_MS = process.env.ADAL_INGEST_TICK_MS ? Number(process.env.ADAL_INGEST_TICK_MS) : 10_000   // a new file wakes it at once (wake)
const wakes = new Set()
/** A file came in: read in a moment (it settles first), not at the next look. */
export function wake(ms = SETTLE_MS + 300) { setTimeout(() => { for (const w of wakes) w() }, ms).unref?.() }
const RETRY_BACKOFF_MS = 8000

// Only files that arrive while Adal Keep runs are read. Windows also reports
// files that were already in the folder whenever something touches them (the
// antivirus, search indexing, Explorer thumbnails); those are left alone.
const NEW_FILE_MS = 10 * 60 * 1000

/** When the file arrived in its folder: created there, or moved/renamed in. */
export function arrivedAt(stat) {
  return Math.max(stat.birthtimeMs || 0, stat.ctimeMs || 0)
}

// The document being read right now (files are read one at a time), so any
// step of the reading can say what it is doing: setStage('asking Gemini').
let current = null // { db, id }

// How far the reading is, for the bar on the Profiles page:
// received → looking at it → reading → fields found → saved.
const STEPS = [
  [/^saving it/i, 90],
  [/reading every detail/i, 70],
  [/gemini|mineru|on this pc|passport lines|place of birth/i, 45],
  [/^reading the document/i, 30],
  [/looking at/i, 15],
  [/^starting/i, 5],
]
export function stagePercent(text) {
  const t = String(text || '')
  for (const [re, pct] of STEPS) if (re.test(t)) return pct
  return null
}
// id → { pct, at } (in memory: only this PC's worker reads files)
const progress = new Map()
const NEXT = [5, 15, 30, 45, 70, 90, 99]
/** The bar's percent: the step reached, creeping toward the next while it lasts. */
export function percentNow(p, now = Date.now()) {
  if (!p) return 0
  const next = NEXT.find(n => n > p.pct) ?? 99
  const creep = Math.min(next - p.pct - 2, Math.floor((now - p.at) / 1000))
  return p.pct + Math.max(0, creep)
}

/** Files being read now (with percent) and how many wait. */
export async function readingNow(db) {
  const rows = await db('ingest_queue').whereIn('status', ['pending', 'processing'])
    .where('attempts', '<', MAX_ATTEMPTS)
    .where('created_at', '>=', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .orderBy('id', 'asc').select('id', 'filename', 'status', 'stage')
  const reading = rows.filter(r => r.status === 'processing').map(r => ({
    id: r.id, filename: r.filename, stage: r.stage || null, percent: percentNow(progress.get(r.id)),
  }))
  return { reading, waiting: rows.length - reading.length }
}

export function setStage(text) {
  if (!current) return
  const pct = stagePercent(text)
  const was = progress.get(current.id)
  if (pct != null && (!was || pct > was.pct)) progress.set(current.id, { pct, at: Date.now() })
  current.db('ingest_queue').where('id', current.id)
    .update({ stage: String(text).slice(0, 120), updated_at: new Date().toISOString() }).catch(() => {})
}

/** Shown on the Tasks page for a file that is not even read (too big, wrong type). */
async function noteSkipped(db, filePath, stat, why) {
  await db('ingest_queue').insert({
    filename: path.basename(filePath), full_path: filePath, file_size: stat.size,
    status: 'skipped', attempts: 0, last_error: why,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).catch(() => {})
}

/**
 * Queue a file that arrived in a watched folder. `since` (ms): it may have
 * arrived that long ago — the start-up pick-up of what came while Adal Keep
 * was closed; otherwise only files of the last 10 minutes.
 */
export async function enqueueFile(db, filePath, { since = null } = {}) {
  const filename = path.basename(filePath)
  let stat
  try { stat = fs.statSync(filePath) } catch { return }
  if (!stat.isFile()) return

  const arrived = arrivedAt(stat)
  if (since ? arrived < since : Date.now() - arrived > NEW_FILE_MS) return // was already there

  // Skip non-document file types
  const ext = path.extname(filename).toLowerCase()
  const SKIP_EXTS = ['.epub', '.mobi', '.zip', '.rar', '.dmg', '.exe', '.mp4', '.mkv', '.mp3', '.iso']
  if (SKIP_EXTS.includes(ext)) {
    console.log('[QUEUE] skip by extension:', filename)
    return
  }
  const { ALLOWED_EXTS } = await import('./docPipeline.js')
  if (!ALLOWED_EXTS[ext]) return // not a document (installers, archives, partial downloads…)

  // Skip large PDFs (likely books/manuals, > 5MB)
  if (ext === '.pdf' && stat.size > 5 * 1024 * 1024) {
    console.log('[QUEUE] skip large PDF:', filename, '(' + Math.round(stat.size / 1024 / 1024) + 'MB)')
    await noteSkipped(db, filePath, stat, 'large_pdf')
    return
  }

  // Already queued (pending or processing)?
  const existing = await db('ingest_queue')
    .where('filename', filename)
    .whereIn('status', ['pending', 'processing'])
    .first()
  if (existing) return

  // Seen already since it arrived (read, or left alone with a reason): the
  // folder check every 30 s must not take it again.
  const seen = await db('ingest_queue')
    .where('full_path', filePath).andWhere('file_size', stat.size)
    .andWhere('created_at', '>=', new Date(arrived - 60000).toISOString())
    .first()
  if (seen) return

  // Already ingested into `files` with same name+size? (A copy the Companion
  // parked in the tray is not read yet: it does not count.)
  const done = await db('files')
    .where('original_name', filename)
    .andWhere('size', stat.size)
    .whereNotNull('profile_field_id')
    .first()
  if (done) return

  await db('ingest_queue').insert({
    filename,
    full_path: filePath,
    file_size: stat.size,
    status: 'pending',
    attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  console.log('[QUEUE] +', filename, '(' + stat.size + ' bytes)')
  wake()
}

/**
 * At start-up: files that were waiting (or being read) when Adal Keep closed
 * are read now — a restart no longer loses them. Only older than a day: left.
 */
export async function purgeStale(db) {
  const now = new Date().toISOString()
  const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString()
  const back = await db('ingest_queue')
    .whereIn('status', ['pending', 'processing']).andWhere('created_at', '>=', dayAgo)
    .update({ status: 'pending', started_at: null, updated_at: now })
  const n = await db('ingest_queue')
    .whereIn('status', ['pending', 'processing'])
    .update({ status: 'expired', last_error: 'older than a day', updated_at: now })
  if (back || n) console.log('[QUEUE] after the restart:', back, 'file(s) read again,', n, 'too old')
}

/**
 * Optional: list what's currently in Downloads (for logs only — nothing queued).
 */
export function listDownloads(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(n => !n.startsWith('.')).map(name => {
    const full = path.join(dir, name)
    try { const s = fs.statSync(full); return { name, size: s.size, mtime: Math.round(s.mtimeMs), isFile: s.isFile() } }
    catch { return { name, size: 0, mtime: 0, isFile: false } }
  }).filter(x => x.isFile)
}

async function processOne(db, processorFn, tag) {
  const cutoff = new Date(Date.now() - SETTLE_MS).toISOString()
  const row = await db('ingest_queue')
    .where('status', 'pending')
    .where('attempts', '<', MAX_ATTEMPTS)
    .where('created_at', '<', cutoff)
    .orderBy('id', 'asc')
    .first()
  if (!row) return false

  if (row.attempts > 0 && row.updated_at) {
    const wait = row.attempts * RETRY_BACKOFF_MS
    const age = Date.now() - new Date(row.updated_at).getTime()
    if (age < wait) return false
  }

  if (!fs.existsSync(row.full_path)) {
    await db('ingest_queue').where('id', row.id).update({
      status: 'skipped', last_error: 'file gone', updated_at: new Date().toISOString(),
    })
    return true
  }

  // Queued by an older version for a file that was already in the folder.
  try {
    const st = fs.statSync(row.full_path)
    if (new Date(row.created_at).getTime() - arrivedAt(st) > NEW_FILE_MS) {
      await db('ingest_queue').where('id', row.id).update({
        status: 'skipped', last_error: 'was already in the folder', updated_at: new Date().toISOString(),
      })
      return true
    }
  } catch {}

  // Atomically claim row to avoid race conditions between parallel workers
  const updatedCount = await db('ingest_queue')
    .where('id', row.id)
    .where('status', 'pending')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  if (updatedCount === 0) return false

  console.log(tag, 'processing', row.filename, '(attempt', row.attempts + 1, ')')
  current = { db, id: row.id }
  setStage('starting')

  try {
    const result = await processorFn(row.full_path, db)
    const ok = result && result.ok
    const reason = result?.reason || 'unknown'

    if (ok) {
      const prof = result.profileId ? await db('profiles').where('id', result.profileId).first().catch(() => null) : null
      await db('ingest_queue').where('id', row.id).update({
        status: 'done', stage: null, finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        result: JSON.stringify({ docType: result.docType, profileId: result.profileId, profileName: prof?.full_name || null, created: !!result.created }),
      })
      console.log(tag, 'done', row.filename)
    } else if (reason === 'analyzer_failed' && !String(row.last_error || '').includes('is not defined')) {
      // Retry — likely transient (network, API hiccup)
      await db('ingest_queue').where('id', row.id).update({
        status: 'pending', attempts: row.attempts + 1,
        last_error: reason, updated_at: new Date().toISOString(),
      })
      console.log(tag, 'will retry', row.filename, '(transient)')
    } else {
      // Permanent skip: other, low_confidence, no_text, already_ingested, no_slip_match, etc.
      const prof = result?.profileId ? await db('profiles').where('id', result.profileId).first().catch(() => null) : null
      await db('ingest_queue').where('id', row.id).update({
        status: 'skipped', stage: null, last_error: reason, updated_at: new Date().toISOString(),
        result: JSON.stringify({ docType: result?.docType || null, profileId: result?.profileId || null, profileName: prof?.full_name || null }),
      })
      console.log(tag, 'skipped', row.filename, '(' + reason + ')')
    }
  } catch (e) {
    await db('ingest_queue').where('id', row.id).update({
      status: 'pending', attempts: row.attempts + 1,
      last_error: String(e.message || e).slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    console.log(tag, 'error', row.filename, '-', e.message)
  } finally {
    progress.delete(row.id)
    current = null
  }
  return true
}

export function startQueueWorker(db, processorFn, tag = '[QUEUE]', watchDir = null, concurrency = 3) {
  purgeStale(db).then(() => wake()).catch(() => {})

  console.log(tag, 'worker started (concurrency', concurrency + ', tick ' + TICK_MS + 'ms)')

  // Fire N parallel loops that each drain one file at a time
  for (let w = 0; w < concurrency; w++) {
    // A reading takes many seconds: the next tick waits for it, or every
    // second another file would start beside it (10 files at once on a 4 GB PC).
    let busy = false
    const go = async () => {
      if (busy) return
      busy = true
      try {
        // Done with one: the next one at once, not a second later.
        while (await processOne(db, processorFn, `${tag}#${w}`)) {}
      } catch (e) {
        console.log(tag, 'worker', w, 'error:', e.message)
      } finally { busy = false }
    }
    wakes.add(go)
    setInterval(go, TICK_MS + w * 300) // stagger startup
  }
}