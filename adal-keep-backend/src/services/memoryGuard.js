/**
 * memoryGuard.js — Adal Keep's own use of the PC's memory is checked every 5 minutes.
 * When the PC is short of memory (or this server grew big) and no robot is working,
 * Adal Browser is quit (its sign-ins stay on disk; the next run starts it again).
 * A browser a robot or a person is using is never touched here (sessionKeeper decides
 * that for the idle case; this only adds the memory reason).
 */
import os from 'os'

export const LOW_FREE_MB = Number(process.env.ADAL_LOW_FREE_MB) || 500
export const BIG_RSS_MB = Number(process.env.ADAL_BIG_RSS_MB) || 1500

/** Pure: should the idle browser go? */
export function shouldQuit({ freeMB, rssMB, working }) {
  return working === 0 && (freeMB < LOW_FREE_MB || rssMB > BIG_RSS_MB)
}

export function startMemoryGuard({ working = () => 0, quit, log = console.log } = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.ADAL_MEMORY_GUARD === '0') return null
  const t = setInterval(async () => {
    try {
      const freeMB = Math.round(os.freemem() / 1048576), rssMB = Math.round(process.memoryUsage().rss / 1048576)
      if (!shouldQuit({ freeMB, rssMB, working: working() })) return
      log(`[memory] ${freeMB} MB free, server ${rssMB} MB, no robot working — quitting the idle browser`)
      await quit?.()
    } catch {}
  }, 5 * 60 * 1000)
  t.unref?.()
  return t
}
