/**
 * runQueue.test.js — how many runs work at once, and who starts next.
 *
 * Replaces the 10-agent pool. The queue must never run more than `max` runs,
 * never run one row twice, start the next waiting run by itself when a slot
 * frees, and know the instant a run has started (the start route reports it
 * straight back to the operator).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createRunQueue } from '../src/services/runQueue.js'

const quiet = () => {}

/** A fake automation_queue: pending ids, claimed oldest first, like claimNextJob. */
function fakeQueue(ids) {
  const pending = [...ids]
  const claimed = []
  return {
    pending,
    claimed,
    async claimNext(exclude = []) {
      await Promise.resolve() // a real claim awaits the database
      const i = pending.findIndex(id => !exclude.includes(id))
      if (i === -1) return null
      const [id] = pending.splice(i, 1)
      claimed.push(id)
      return { id, workflow_id: 'police_certificate', profile_id: 100 + id }
    },
  }
}

/** runJob that stays "in the browser" until the test finishes it. */
function controllableRuns() {
  const live = new Map()
  return {
    live,
    runJob: (job) => new Promise((resolve, reject) => { live.set(job.id, { resolve, reject }) }),
    finish(id) { live.get(id).resolve(); live.delete(id) },
    crash(id) { live.get(id).reject(new Error('tab closed')); live.delete(id) },
  }
}

const settle = () => new Promise(r => setTimeout(r, 10))

test('never runs more than max at once, oldest first', async () => {
  const q = fakeQueue([1, 2, 3, 4])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 2, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  await runs.drain()
  assert.deepEqual(runs.snapshot().running.map(x => x.runId), [1, 2])
  assert.deepEqual(q.pending, [3, 4])
})

test('a finished run frees its slot and the next one starts by itself', async () => {
  const q = fakeQueue([1, 2, 3])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 2, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  await runs.drain()
  await settle()
  r.finish(1)
  await settle()
  assert.deepEqual(runs.snapshot().running.map(x => x.runId).sort(), [2, 3])
  assert.equal(runs.isRunning(1), false)
})

test('a crashed run also frees its slot', async () => {
  const q = fakeQueue([1, 2])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 1, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  await runs.drain()
  await settle()
  r.crash(1)
  await settle()
  assert.deepEqual(runs.snapshot().running.map(x => x.runId), [2])
})

test('many clicks at the same moment cannot overshoot the limit or run a row twice', async () => {
  const q = fakeQueue([1, 2, 3, 4, 5, 6])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 3, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  await Promise.all(Array.from({ length: 8 }, () => runs.drain()))
  assert.equal(runs.snapshot().running.length, 3)
  assert.equal(new Set(q.claimed).size, q.claimed.length)
  assert.deepEqual(q.claimed, [1, 2, 3])
})

test('a run is reported as working as soon as drain() resolves', async () => {
  const q = fakeQueue([])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 2, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  // What the start route does: insert the row, then drain, then ask.
  q.pending.push(7)
  await runs.drain()
  assert.equal(runs.isRunning(7), true)
})

test('a click while a fill pass is in flight is not lost', async () => {
  const q = fakeQueue([1])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 3, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  const first = runs.drain()  // pass 1 starts and is awaiting its claim
  q.pending.push(2)           // a second click inserts its row meanwhile
  const second = runs.drain() // ...and asks for a drain
  await Promise.all([first, second])
  assert.equal(runs.isRunning(2), true)
})

test('a row still finishing here is skipped, then picked up once it is free', async () => {
  const q = fakeQueue([1])
  const r = controllableRuns()
  const runs = createRunQueue({ max: 3, claimNext: q.claimNext, runJob: r.runJob, log: quiet, warn: quiet })

  await runs.drain()
  // Run 1 paused, and a resume put its row back to pending before the run
  // returned: it must not start a second copy of itself.
  q.pending.push(1)
  await runs.drain()
  assert.deepEqual(q.claimed, [1])

  r.finish(1)
  await settle()
  assert.deepEqual(q.claimed, [1, 1])
  assert.equal(runs.isRunning(1), true)
})
