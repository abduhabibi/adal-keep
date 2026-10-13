/**
 * domSelect.js — pure, testable DOM-selection logic.
 *
 * The LMIS/Musaned workflows previously located their modals like this:
 *
 *     const all = Array.from(document.querySelectorAll('*'))
 *     for (const el of all) {
 *       const r = el.getBoundingClientRect()
 *       if (r.width < 250 || r.height < 150) continue
 *       if (r.width > 1400 || r.height > 1200) continue
 *       if ((el.textContent || '').includes(title)) { modal = el; break }
 *     }
 *
 * `querySelectorAll('*')` returns elements in DOCUMENT ORDER, so the first
 * match is an ancestor (`body`, `#root`, the app shell) — never the dialog.
 * `modal.querySelector('input[type="file"]')` then returned the first file
 * input on the *entire page*, which on the police-certificate screen is the
 * Payment Slip slot. The passport ended up attached to the slip slot.
 *
 * This module replaces that guesswork with a deterministic decision over
 * plain serialised element descriptors, so the hard part is unit-testable and
 * contains no browser calls. Callers do exactly two `page.evaluate`s:
 * one to *collect* descriptors, one to *act* on the chosen index.
 */

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Pixel area of a rect descriptor; 0 when degenerate. */
export function area(rect) {
  if (!rect) return 0
  const w = Number(rect.width) || 0
  const h = Number(rect.height) || 0
  if (w <= 0 || h <= 0) return 0
  return w * h
}

/** Smallest dialog that can hold a real form. */
export const MIN_DIALOG_W = 80
export const MIN_DIALOG_H = 60

/**
 * Is this descriptor usable as *the* dialog?
 *
 * Rejects invisible elements and — critically — anything the size of the whole
 * document (`html` / `body` / `#root`), which is what made the old locator
 * collapse to "the entire page".
 */
export function isUsableDialog(c) {
  if (!c) return false
  if (c.visible === false) return false
  if (c.fullViewport === true) return false
  const rect = c.rect || {}
  if ((Number(rect.width) || 0) < MIN_DIALOG_W) return false
  if ((Number(rect.height) || 0) < MIN_DIALOG_H) return false
  return area(rect) > 0
}

// ---------------------------------------------------------------------------
// dialog selection
// ---------------------------------------------------------------------------

function zOf(c) {
  const z = Number(c && c.zIndex)
  return Number.isFinite(z) ? z : 0
}

function textHas(c, needle) {
  if (!needle) return true
  return String((c && c.text) || '').includes(needle)
}

/**
 * Choose the dialog that actually represents `title`.
 *
 * Strategy, in order:
 *   1. usable, on-screen dialogs whose text contains `title` → smallest area
 *      (the most specific container, not an ancestor), tie-break by z-index.
 *   2. if none, usable elements containing `title` that also hold a form
 *      control (`hasControl`) → smallest area, tie-break by z-index.
 *
 * @param {Array<object>} candidates descriptors, each with `idx`
 * @param {string} title        visible modal title
 * @param {object} [opts]
 * @param {boolean} [opts.requireControl] require an input/textarea/button/file
 * @returns {number} index into `candidates`, or -1
 */
export function pickBestDialog(candidates, title, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const { requireControl = false } = opts

  const rank = (a, b) => {
    const d = area(a.rect) - area(b.rect)
    if (d !== 0) return d               // smaller first
    return zOf(b) - zOf(a)              // higher z-index first
  }

  const matches = list.filter(c => isUsableDialog(c) && textHas(c, title))

  // Pass 1 — a real dialog container.
  const dialogs = matches
    .filter(c => c.isDialog === true)
    .filter(c => !requireControl || c.hasControl === true)
    .sort(rank)
  if (dialogs.length) return dialogs[0].idx

  // Pass 2 — any usable container holding the title and (optionally) a control.
  const containers = matches
    .filter(c => !requireControl || c.hasControl === true)
    .sort(rank)
  if (containers.length) return containers[0].idx

  return -1
}

// ---------------------------------------------------------------------------
// file input selection
// ---------------------------------------------------------------------------

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * Score one file input against the file we want to upload.
 * Higher is better; -1 means "this input cannot accept the file".
 *
 * accept attribute grammar: comma-separated `type/subtype`, `.ext`, `type/*`.
 * An EMPTY accept is a wildcard (any file) — still acceptable, but ranked
 * below an input that positively declares the right type.
 *
 * NOTE: file inputs are *legitimately* hidden (`display:none` behind a "Browse"
 * label, or a 0x0 FilePond input). Visibility must therefore never be a hard
 * filter — it is only a small tie-break bonus. Correctness comes from the fact
 * that callers already scoped the search to the resolved dialog.
 */
export function scoreFileInput(input, filePath) {
  if (!input) return -1

  const ext = extOf(filePath)
  const mime = MIME_BY_EXT[ext] || ''
  const accept = String(input.accept || '').trim().toLowerCase()

  let score
  if (!accept || accept === '*/*') {
    score = 10                                  // wildcard — usable, low rank
  } else {
    let best = -1
    for (const raw of accept.split(',')) {
      const a = raw.trim()
      if (!a) continue
      if (a.startsWith('.')) {
        if (ext && a.slice(1) === ext) best = Math.max(best, 100)
        continue
      }
      if (mime && a === mime) best = Math.max(best, 90)
      else if (mime && a.endsWith('/*') && mime.startsWith(a.slice(0, -1))) best = Math.max(best, 50)
    }
    score = best                                // -1 when nothing matched
  }

  // Prefer a real, laid-out dropzone over a 0x0 hidden input.
  if (score >= 0 && input.visible !== false && area(input.rect) > 0) score += 5
  return score
}

/**
 * Pick the file input inside the resolved dialog that best matches `filePath`.
 *
 * Inside one dialog there is normally a single input, so a *mismatched* accept
 * attribute must not veto the upload — LMIS renders several widgets that leave
 * `accept` empty or wrong. We only fall back to the first input when nothing
 * declared a match at all.
 *
 * @returns {number} index into `inputs`, or -1 when the list is empty
 */
export function pickFileInput(inputs, filePath) {
  const list = Array.isArray(inputs) ? inputs : []
  if (!list.length) return -1

  let bestIdx = -1
  let bestScore = -1
  for (const input of list) {
    const s = scoreFileInput(input, filePath)
    if (s > bestScore) { bestScore = s; bestIdx = input.idx }
  }
  if (bestScore >= 0) return bestIdx
  return list[0].idx
}

// ---------------------------------------------------------------------------
// upload read-back
// ---------------------------------------------------------------------------

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')       // drop extension
    .replace(/[^a-z0-9]/g, '')         // drop separators/spaces
}

/**
 * Did the dialog actually accept the file we sent?
 *
 * LMIS echoes the chosen filename (often with separators mangled) and shows an
 * "Upload Complete" state. Accept either, so a rename by the widget does not
 * produce a false negative.
 *
 * @param {string} modalText   innerText of the resolved dialog
 * @param {string} basename    basename of the file we uploaded
 * @returns {{ok:boolean, reason:string}}
 */
export function confirmsUpload(modalText, basename) {
  const text = String(modalText || '')
  const lower = text.toLowerCase()

  if (/upload\s*complete/.test(lower) || lower.includes('tap to undo')) {
    return { ok: true, reason: 'upload-complete-marker' }
  }

  const want = normalizeForCompare(basename)
  if (!want) return { ok: false, reason: 'empty-filename' }
  if (normalizeForCompare(text).includes(want)) {
    return { ok: true, reason: 'filename-echoed' }
  }

  return { ok: false, reason: 'filename-not-found' }
}

// ---------------------------------------------------------------------------
// dropdown option selection
// ---------------------------------------------------------------------------

/**
 * Pick the option in an open listbox that matches `wanted`.
 * Exact (case-insensitive) match wins; then a startsWith; then includes.
 * @returns {number} index into `options`, or -1
 */
export function pickOption(options, wanted) {
  const list = Array.isArray(options) ? options : []
  const want = String(wanted || '').trim().toLowerCase()
  if (!want) return -1
  const label = o => String((o && o.text) || '').trim().toLowerCase()

  for (const o of list) if (label(o) === want) return o.idx
  for (const o of list) if (label(o).startsWith(want)) return o.idx
  for (const o of list) if (label(o).includes(want)) return o.idx
  return -1
}

export default {
  area,
  isUsableDialog,
  pickBestDialog,
  scoreFileInput,
  pickFileInput,
  confirmsUpload,
  pickOption,
}
