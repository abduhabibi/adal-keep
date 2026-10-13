/**
 * cancellation.js — cooperative "stop now" signal for running automation jobs.
 *
 * PROBLEM it solves
 * -----------------
 * The old cancel endpoint only flipped the row's status to `cancelled` in the
 * DB. The workflow already running in the browser never looked at that, so the
 * agent kept clicking/typing to the end. Now the cancel endpoint calls
 * `markCancelled(runId)` and the workflow's step logger throws a
 * `CancelledError`, which unwinds the run immediately and the worker records
 * the job as cancelled.
 *
 * The flag list is intentionally tiny + process-local: a run only needs to
 * outlive the current job, and the worker clears its flag in a `finally`.
 */

export class CancelledError extends Error {
  constructor(message = 'Cancelled by user') {
    super(message)
    this.name = 'CancelledError'
    this.cancelled = true
  }
}

const _cancelled = new Set()

export function markCancelled(runId) {
  if (runId === undefined || runId === null) return
  _cancelled.add(Number(runId))
}

export function clearCancelled(runId) {
  _cancelled.delete(Number(runId))
}

export function isCancelled(runId) {
  return _cancelled.has(Number(runId))
}

/** Throw a CancelledError if this run has been cancelled. */
export function throwIfCancelled(runId) {
  if (isCancelled(runId)) throw new CancelledError()
}
