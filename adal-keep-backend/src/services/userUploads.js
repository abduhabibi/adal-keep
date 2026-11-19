/**
 * userUploads.js — the user's own uploads come first on the line.
 *
 * Asked on 2026-11-19 ("don't upload to the internet when I am uploading"):
 * while someone puts files into Adal Keep — scans, photos, documents, on the
 * main PC or through a Companion — the online copy (cloudSync.js) and the
 * backup (telegramBackup.js) send nothing more to the internet, so the
 * person's upload gets the whole line. They go on about 30 s after the last
 * upload ended. Nothing is skipped or lost: what was due waits and then goes,
 * in the same order. (A piece already on its way when an upload starts
 * finishes; the next one waits.)
 *
 *   trackUserUploads   express middleware: counts the uploads coming in
 *   uploadsBusy()      an upload now, or one ended less than 30 s ago
 *   waitForQuiet()     resolves once uploadsBusy() is false
 */
export const QUIET_MS = Number(process.env.ADAL_UPLOAD_QUIET_MS) || 30 * 1000

let active = 0
let lastEnd = 0
let clock = () => Date.now()

/** A request that brings files: a form with files, or a big body. Not the app's own small calls. */
export function isUserUpload(req) {
  const m = String(req.method || 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || m === 'DELETE') return false
  const p = String(req.path || req.url || '')
  if (!p.startsWith('/api')) return false
  // Adal Keep's own sync with other PCs is not a person's upload.
  if (/^\/api\/(replica|system\/update|pc-access|health)/.test(p)) return false
  const type = String(req.headers?.['content-type'] || '').toLowerCase()
  if (type.startsWith('multipart/form-data')) return true
  if (p === '/api/companion/ingest') return true                  // a Companion's scans
  return Number(req.headers?.['content-length'] || 0) > 512 * 1024 // a big body (a photo sent as data)
}

export function uploadStarted() { active++ }
export function uploadEnded() { active = Math.max(0, active - 1); lastEnd = clock() }

export function trackUserUploads(req, res, next) {
  if (!isUserUpload(req)) return next()
  uploadStarted()
  let done = false
  const end = () => { if (!done) { done = true; uploadEnded() } }
  res.on('finish', end)
  res.on('close', end)
  next()
}

/** Someone is uploading now, or stopped less than QUIET_MS ago. */
export function uploadsBusy(now = clock()) {
  return active > 0 || (lastEnd > 0 && now - lastEnd < QUIET_MS)
}

export const uploadState = () => ({ active, lastEnd, busy: uploadsBusy() })

/**
 * Waits until nobody has uploaded for QUIET_MS. `onWait` is told once when it
 * has to wait (for the log / the status). Never gives up: it only delays.
 */
export async function waitForQuiet({ onWait, every = 1000 } = {}) {
  if (!uploadsBusy()) return false
  onWait?.()
  while (uploadsBusy()) await new Promise(ok => setTimeout(ok, every))
  return true
}

// Tests: a clock that moves when told to.
export function _setClock(fn) { clock = fn || (() => Date.now()) }
export function _reset() { active = 0; lastEnd = 0 }
