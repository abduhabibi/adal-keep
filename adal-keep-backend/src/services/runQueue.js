/**
 * runQueue.js — how many automation runs work at once, and which one starts next.
 *
 * There is no pool of numbered agents. A run is a row in automation_queue.
 * When a slot is free it starts straight away in its own browser tab; when
 * `max` runs are already working it waits in line and starts by itself,
 * oldest first, as soon as one of them finishes.
 *
 * Only the counting and ordering live here, so this can be tested without a
 * database or a browser: `claimNext(excludeIds)` hands out the next job (or
 * null) and `runJob(job)` does the work. worker.js wires in the real ones.
 */

export function createRunQueue({ max = 3, claimNext, runJob, log = console.log, warn = console.error } = {}) {
  const limit = Math.max(1, Number(max) || 1)

  // runId -> { runId, workflowId, profileId, startedAt } for runs working now
  const running = new Map()

  // Fill passes run one after another, never two at once, so the slot count
  // cannot be overshot. `waiting` = a pass is scheduled but has not started:
  // a new request can share it, because it will read the queue after now.
  let chain = Promise.resolve()
  let waiting = false

  function start(job) {
    const runId = Number(job.id)
    running.set(runId, {
      runId,
      workflowId: job.workflow_id,
      profileId: job.profile_id,
      startedAt: new Date().toISOString(),
    })
    log(`[runs] run #${runId} ${job.workflow_id} (profile ${job.profile_id}) started — ${running.size}/${limit} working`)
    Promise.resolve()
      .then(() => runJob(job))
      .catch(e => warn(`[runs] run #${runId} crashed: ${e?.message || e}`))
      .finally(() => {
        running.delete(runId)
        drain() // a slot is free: the next run in line starts by itself
      })
  }

  async function fill() {
    while (running.size < limit) {
      // Runs still finishing here are skipped even if their row already says
      // pending again (a resume clicked a moment early): one row, one run.
      const job = await claimNext([...running.keys()])
      if (!job) break
      start(job)
    }
  }

  /** Start as many waiting runs as there are free slots. Safe to call any time. */
  function drain() {
    if (waiting) return chain
    waiting = true
    chain = chain
      .then(() => { waiting = false; return fill() })
      .catch(e => warn(`[runs] could not start waiting runs: ${e?.message || e}`))
    return chain
  }

  return {
    drain,
    isRunning: (runId) => running.has(Number(runId)),
    snapshot: () => ({ max: limit, running: [...running.values()] }),
  }
}
