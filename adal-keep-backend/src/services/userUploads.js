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
  notePerson(req)
  if (!isUserUpload(req)) return next()
  uploadStarted()
  let done = false
  const end = () => { if (!done) { done = true; uploadEnded() } }
  res.on('finish', end)
  res.on('close', end)
  next()
}

// ── A person's clicks first ──────────────────────────────────────────────────
// A page opened or saved by a person (not Adal Keep's own sweeps, not the looks an open
// window repeats by itself): heavy background work waits a moment for it.
export const CLICK_MS = 2500
let lastClick = 0
const REPEATED = /^\/api\/(health|app|live|events|attention|notifications|automations\/(active|attention)|main-pc|pc-access|companion|replica|sync|system|chat|robots|sessions|safety|setup|subscription)\b/
export function notePerson(req) {
  if (req.headers?.['x-adal-cloud'] || req.headers?.['x-adal-robots']) return
  const p = String(req.path || req.url || '')
  if (p.startsWith('/api') && !REPEATED.test(p)) lastClick = clock()
}
export const personBusy = (now = clock()) => lastClick > 0 && now - lastClick < CLICK_MS
/** Waits while a person clicks, at most `max` ms (background work is slowed, never stopped). */
export async function afterClicks({ max = 20_000, every = 250 } = {}) {
  for (let waited = 0; personBusy() && waited < max; waited += every) await new Promise(ok => setTimeout(ok, every))
}
/** A breath between two pieces of background work, as long as they leave this PC free: `share` of one processor at most. */
export const breath = (workedMs, { share = 0.08, min = 20, max = 1500 } = {}) =>
  new Promise(ok => setTimeout(ok, Math.max(min, Math.min(max, workedMs * (1 / share - 1)))))

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
export function _reset() { active = 0; lastEnd = 0; lastClick = 0 }
