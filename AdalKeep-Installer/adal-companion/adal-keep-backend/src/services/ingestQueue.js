import fs from 'fs'
import path from 'path'

const SETTLE_MS = 3000
const MAX_ATTEMPTS = 5
const TICK_MS = 2000
const RETRY_BACKOFF_MS = 8000

export async function enqueueFile(db, filePath) {
  const filename = path.basename(filePath)
  let stat
  try { stat = fs.statSync(filePath) } catch { return }
  if (!stat.isFile()) return

  // Skip non-document file types
  const ext = path.extname(filename).toLowerCase()
  const SKIP_EXTS = ['.epub', '.mobi', '.zip', '.rar', '.dmg', '.exe', '.mp4', '.mkv', '.mp3', '.iso']
  if (SKIP_EXTS.includes(ext)) {
    console.log('[QUEUE] skip by extension:', filename)
    return
  }

  // Skip large PDFs (likely books/manuals, > 5MB)
  if (ext === '.pdf' && stat.size > 5 * 1024 * 1024) {
    console.log('[QUEUE] skip large PDF:', filename, '(' + Math.round(stat.size / 1024 / 1024) + 'MB)')
    return
  }

  // Already queued (pending or processing)?
  const existing = await db('ingest_queue')
    .where('filename', filename)
    .whereIn('status', ['pending', 'processing'])
    .first()
  if (existing) return

  // Already ingested into `files` with same name+size?
  const done = await db('files')
    .where('original_name', filename)
    .andWhere('size', stat.size)
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
}

/**
 * Boot-time purge: any row left pending/processing from a previous run
 * is stale — we only process files that appear while the server is up.
 */
export async function purgeStale(db) {
  const n = await db('ingest_queue')
    .whereIn('status', ['pending', 'processing'])
    .update({ status: 'expired', last_error: 'server restart', updated_at: new Date().toISOString() })
  if (n > 0) console.log('[QUEUE] expired', n, 'stale row(s) from previous session')
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

  try {
    const result = await processorFn(row.full_path, db)
    const ok = result && result.ok
    const reason = result?.reason || 'unknown'

    if (ok) {
      await db('ingest_queue').where('id', row.id).update({
        status: 'done', finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
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
      await db('ingest_queue').where('id', row.id).update({
        status: 'skipped', last_error: reason, updated_at: new Date().toISOString(),
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
  }
  return true
}

export function startQueueWorker(db, processorFn, tag = '[QUEUE]', watchDir = null, concurrency = 3) {
  purgeStale(db).then(() => {
    if (watchDir) {
      const files = listDownloads(watchDir)
      console.log(tag, 'Downloads snapshot:', files.length, 'file(s) — watching new arrivals only')
    }
  }).catch(() => {})

  console.log(tag, 'worker started (concurrency', concurrency + ', tick ' + TICK_MS + 'ms)')

  // Fire N parallel loops that each drain one file at a time
  for (let w = 0; w < concurrency; w++) {
    setInterval(async () => {
      try {
        await processOne(db, processorFn, `${tag}#${w}`)
      } catch (e) {
        console.log(tag, 'worker', w, 'error:', e.message)
      }
    }, TICK_MS + w * 300) // stagger startup
  }
}