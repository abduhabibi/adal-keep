import os from 'os'
import path from 'path'
import { startWatcher } from './docPipeline.js'
import { startQueueWorker } from './ingestQueue.js'
import { analyzeWithMineru } from './mineruClassifier.js'

// Folders watched for new documents. WATCH_DIR may list several, separated
// by ";". Default: the user's Downloads folder (browser and Telegram saves),
// plus Telegram Desktop's own folder and the inbox on Windows.
const DOWNLOADS = path.join(os.homedir(), 'Downloads')
const WATCH_DIRS = (process.env.WATCH_DIR
  ? process.env.WATCH_DIR.split(';')
  : process.platform === 'win32'
    ? [DOWNLOADS, path.join(DOWNLOADS, 'Telegram Desktop'), 'C:\\AdalKeep\\inbox']
    : [DOWNLOADS]
).map(d => d.trim()).filter(Boolean)

/**
 * The processor function the queue worker calls for each row.
 * This is what actually runs the classification pipeline.
 *
 * JEV first (typed answers: field, person, MRZ box), then local OCR / Gemini / MinerU.
 */
export async function processFile(filePath, db) {
  console.log(`[AI] 📄 Processing: ${filePath}`)
  return runPipeline(filePath, db, (p) => analyzeWithMineru(p, { db }), '[AI]')
}

// Lazy import to avoid circular dependency (docPipeline → ingestQueue → aiIngestion)
import { runPipeline } from './docPipeline.js'

export function startFolderWatcher(db) {
  console.log(`[AI] vision pipeline watching ${WATCH_DIRS.join(' | ')}`)

  // Layer 1 — watcher: detects new files and records them in the ingest_queue
  //           (dedup by filename + size, settle time 3s, so partial copies are ignored)
  for (const dir of WATCH_DIRS) startWatcher(dir, db, processFile, '[AI]')

  // Layer 2 — worker: drains ingest_queue one file at a time (concurrency 1)
  //           and retries transient MinerU failures with backoff
  startQueueWorker(db, processFile, '[QUEUE]', WATCH_DIRS[0], 1)
}