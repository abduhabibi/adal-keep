/**
 * passportScan.js — one passport scan, from the file to the fields, in a fixed order.
 *
 *  1. Scans take their turn, one at a time, oldest first (queue below): a slow page
 *     never lets the next one start while the reader is busy with it.
 *  2. The bottom lines are read on this PC with the warm OCR-B reader (quickMrz.js).
 *     The moment every check digit verifies the scan answers; the place of birth,
 *     region and date of issue (one small Gemini question) come BEHIND it
 *     (r.placeLater) and never hold the answer up.
 *  3. Only when the local read finds nothing (a bad photo, no OCR-B model) the
 *     slower readers are asked (JEV, Gemini, the full OCR) — that happens outside
 *     the queue, so the next click is not waiting for it, and the page is told
 *     step by step what is going on (job.step).
 *  A read that does not verify is never guessed: it is a failure, said as such.
 */
import { analyzeWithMineru } from './mineruClassifier.js'
import { quickMrz } from './quickMrz.js'
import { readVisual } from './passportVisual.js'

/** Time a local read may take before the page is told "still reading" (the scan goes on). */
export const FIRST_MS = Number(process.env.SCAN_FIRST_MS || 4500)
/** The scan waits for the page's printed details (place, issue date) until this long after it started (they are read after the bottom lines, not beside them: two readers on a small PC would slow both); later ones follow behind. */
const DETAILS_BY_MS = Number(process.env.SCAN_DETAILS_BY_MS || 3000)
const LOCAL_BUDGET_MS = Number(process.env.SCAN_LOCAL_BUDGET_MS || 20000)

let line = Promise.resolve()
/** Run `fn` after every earlier scan's local stage; its failure never stops the next one. */
const inTurn = (fn) => { const run = line.then(fn); line = run.then(() => {}, () => {}); return run }

/**
 * Scan one file. `onStep('waiting'|'reading'|'checking'|'asking the cloud readers'|'done')`
 * tells the page where it is. Resolves like analyzeWithMineru: { doc_type, fields, placeLater, ... }.
 */
export async function scan(file, { db = null, onStep = () => {} } = {}) {
  const t0 = Date.now()
  onStep('waiting')
  const quick = await inTurn(() => quickMrz(file, { deadline: Date.now() + LOCAL_BUDGET_MS, onStep }).catch(() => null))
  if (quick) {
    // The place of birth and date of issue are read from the page on this PC (no network). They join the
    // answer when they are ready by DETAILS_BY_MS; else they follow in r.placeLater, ahead of Gemini's.
    const details = readVisual(file, quick, { deadline: t0 + DETAILS_BY_MS }).catch(() => null)
    const wait = Math.max(0, t0 + DETAILS_BY_MS - Date.now())
    const early = await Promise.race([details, new Promise(res => setTimeout(() => res(null), wait))])
    const mine = (v) => Object.fromEntries(Object.entries({ place_of_birth: v?.place_of_birth, date_of_issue: v?.date_of_issue }).filter(([, x]) => x))
    if (early) Object.assign(quick.fields, mine(early))
    onStep('done')
    const r = await analyzeWithMineru(file, { db, placeLater: true, quickResult: quick })
    // What the page tells wins; Gemini only adds what it could not (and may have answered before it).
    if (!early && r.placeLater) r.placeLater = Promise.all([details, r.placeLater]).then(([v, g]) => ({ ...(g || {}), ...mine(v) }))
    return r
  }
  onStep('asking the cloud readers')
  const r = await analyzeWithMineru(file, { db, placeLater: true, quickDone: true })
  onStep('done')
  return r
}
