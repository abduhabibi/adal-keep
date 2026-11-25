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

/** Time a local read may take before the page is told "still reading" (the scan goes on). */
export const FIRST_MS = Number(process.env.SCAN_FIRST_MS || 4500)
const LOCAL_BUDGET_MS = Number(process.env.SCAN_LOCAL_BUDGET_MS || 20000)

let line = Promise.resolve()
/** Run `fn` after every earlier scan's local stage; its failure never stops the next one. */
const inTurn = (fn) => { const run = line.then(fn); line = run.then(() => {}, () => {}); return run }

/**
 * Scan one file. `onStep('waiting'|'reading'|'checking'|'asking the cloud readers'|'done')`
 * tells the page where it is. Resolves like analyzeWithMineru: { doc_type, fields, placeLater, ... }.
 */
export async function scan(file, { db = null, onStep = () => {} } = {}) {
  onStep('waiting')
  const quick = await inTurn(() => quickMrz(file, { deadline: Date.now() + LOCAL_BUDGET_MS, onStep }).catch(() => null))
  if (quick) {
    onStep('done')
    return analyzeWithMineru(file, { db, placeLater: true, quickResult: quick })
  }
  onStep('asking the cloud readers')
  const r = await analyzeWithMineru(file, { db, placeLater: true, quickDone: true })
  onStep('done')
  return r
}
