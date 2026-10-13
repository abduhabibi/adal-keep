import { startWatcher } from './docPipeline.js'
import { startQueueWorker } from './ingestQueue.js'
import { analyzeDocument } from './deepseekVision.js'

const WATCH_DIR = process.env.WATCH_DIR ||
  (process.platform === 'win32' ? 'C:\\AdalKeep\\inbox' : '/home/abduhabibi/Downloads')

/**
 * The processor function the queue worker calls for each row.
 * This is what actually runs the vision pipeline.
 */
export async function processFile(filePath, db) {
  console.log(`[AI] 📄 Processing: ${filePath}`)
  return runPipeline(filePath, db, analyzeDocument, '[AI]')
}

// Lazy import to avoid circular dependency (docPipeline → ingestQueue → aiIngestion)
import { runPipeline } from './docPipeline.js'

export function startFolderWatcher(db) {
  console.log(`[AI] vision pipeline watching ${WATCH_DIR}`)

  // Layer 1 — watcher: detects new files and records them in the ingest_queue
  //           (dedup by filename + size, settle time 3s, so partial copies are ignored)
  startWatcher(WATCH_DIR, db, processFile, '[AI]')

  // Layer 2 — worker: drains ingest_queue serially and calls processFile
  //           (3 concurrent workers, retries failed vision calls with backoff)
  startQueueWorker(db, processFile, '[QUEUE]', WATCH_DIR, 3)
}