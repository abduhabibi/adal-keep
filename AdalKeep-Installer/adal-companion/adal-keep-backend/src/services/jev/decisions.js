/**
 * Named decisions built on top of client.askJev.
 *
 * Every function returns a plain object the caller can switch on.
 * Never throws. On Jev failure, returns the SAFE fallback for that
 * decision (see each function's `fallback` comment).
 */

import { askJev } from './client.js'

/* ── 1. COMPLETION REVIEW ─────────────────────────────────────────────
 * Fallback on Jev failure: 'verify_more' (never auto-complete).
 */
export async function reviewCompletion({ workflow, step, evidence, ctx }) {
  const state = {
    workflow,
    step,
    evidence,
    note: 'Decide whether the step is genuinely complete given the evidence.',
  }
  const { ok, answers } = await askJev(state, {
    verdict: {
      type: 'Choice',
      options: ['complete', 'verify_more', 'incomplete'],
      instructions:
        'Pick "complete" only if ALL evidence signals agree the step succeeded. ' +
        'If the UI signal says done but the modal is still open or the server ' +
        'has not confirmed, pick "verify_more". If a deterministic failure signal ' +
        'is present (error text, red banner), pick "incomplete".',
    },
  })
  if (!ok) return { verdict: 'verify_more', source: 'fallback' }
  return { verdict: answers.verdict?.choice || 'verify_more', source: 'jev' }
}

/* ── 2. UPLOAD VERIFICATION ───────────────────────────────────────────
 * Fallback on Jev failure: 'retry' (safe — a retry never harms).
 */
export async function reviewUpload({
  workflow, step, uploadSignal, modalState, serverConfirmed, attempt, maxAttempts,
}) {
  const state = {
    workflow, step,
    uploadSignal,
    modalState,
    serverConfirmed,
    attempt, maxAttempts,
  }
  const { ok, answers } = await askJev(state, {
    action: {
      type: 'Choice',
      options: ['continue', 'retry', 'pause'],
      instructions:
        'If serverConfirmed is true AND modalState is "closed", pick "continue". ' +
        'If attempt < maxAttempts AND (serverConfirmed false OR modalState "still_open"), ' +
        'pick "retry". Otherwise pick "pause".',
    },
  })
  if (!ok) return { action: attempt < maxAttempts ? 'retry' : 'pause', source: 'fallback' }
  return { action: answers.action?.choice || 'retry', source: 'jev' }
}

/* ── 3. CONTRACT SUBMIT LOOP ──────────────────────────────────────────
 * Fallback on Jev failure: keep going until attempt cap.
 */
export async function reviewSubmitLoop({
  workflow, attempt, maxAttempts, modalState, pageText,
}) {
  const state = {
    workflow, attempt, maxAttempts,
    modalState,
    pageText: (pageText || '').slice(0, 600),
  }
  const { ok, answers } = await askJev(state, {
    action: {
      type: 'Choice',
      options: ['done', 'keep_trying', 'give_up'],
      instructions:
        'If modalState is "closed" pick "done". ' +
        'If modalState is "still_open" AND attempt < maxAttempts ' +
        'AND pageText has no terminal error (already attached / exists / duplicate), ' +
        'pick "keep_trying". ' +
        'If a terminal error IS present OR attempt >= maxAttempts, pick "give_up".',
    },
  })
  if (!ok) {
    return {
      action: attempt >= maxAttempts ? 'give_up' : 'keep_trying',
      source: 'fallback',
    }
  }
  return { action: answers.action?.choice || 'keep_trying', source: 'jev' }
}
