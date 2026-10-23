/**
 * How many automation runs are working right now (worker.js reports it).
 * Background jobs that use the internet — the Telegram backup, the Musaned
 * contract check, the Wafid results check — wait while runs work, so the
 * runs get the whole internet connection.
 */
let count = () => 0
export function reportRuns(fn) { count = fn }
export function runsWorking() { try { return count() || 0 } catch { return 0 } }

/** Runs `job` now when no run is working, else looks again every 5 minutes. */
export function whenRunsIdle(job, tag) {
  const go = () => {
    if (runsWorking() > 0) {
      console.log(`${tag} waiting — ${runsWorking()} run(s) are working`)
      setTimeout(go, 5 * 60 * 1000).unref?.()
      return
    }
    job()
  }
  go()
}
