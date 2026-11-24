/**
 * A document whose row is here but whose file is not yet (asked on 2026-11-23: "it shows
 * that a photo is uploaded but I can't see it"): the agency's PCs copy documents in rounds
 * (sync/node.js docsFrom), so a photo added on another PC can be listed here minutes before
 * its file arrives. Asked for now, it is fetched at once from the agency's other PCs
 * (the same /doc/:name call the rounds use) and kept where the rounds would put it.
 * One fetch per document at a time; a document no PC has is not asked for again for a minute.
 */
import { docNameOf } from './sync/docs.js'

const inFlight = new Map()   // doc name → Promise<boolean>
const missed = new Map()     // doc name → when no PC had it
const AGAIN_MS = 60_000

// A window asking for a picture waits at most this long (asked on 2026-11-24: "Loading the photo…"
// for ever): then it hears "not here yet" and says so; the copy goes on behind and is there next time.
export const ANSWER_MS = 2500
const within = (job, ms) => ms ? Promise.race([job, new Promise(r => setTimeout(() => r(false), ms).unref?.())]) : job
const bounded = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms).unref?.())])

/** True when the file is here now (fetched from another PC); false after answerWithinMs while it is still coming. */
export async function fetchMissing(file, { node = null, timeoutMs = 15_000, answerWithinMs = 0 } = {}) {
  const name = docNameOf(file?.path)
  if (!name) return false
  if (!node) { try { node = (await import('./sync/index.js')).syncNode() } catch { node = null } }
  if (!node?.docs) return false
  if (node.docs.has(name)) return true
  if (Date.now() - (missed.get(name) || 0) < AGAIN_MS) return false
  if (inFlight.has(name)) return within(inFlight.get(name), answerWithinMs)
  const job = (async () => {
    const deadline = Date.now() + timeoutMs
    for (const pc of await node.others().catch(() => [])) {
      if (Date.now() > deadline) break
      try {
        const url = await bounded(node.reach(pc), Math.max(1000, deadline - Date.now()))
        if (!url) continue
        const buf = await node.call(url, 'GET', `/doc/${encodeURIComponent(name)}`, null, { timeout: Math.max(2000, deadline - Date.now()), raw: true })
        if (!buf?.length) continue
        await node.docs.put(name, Buffer.from(buf))
        node.docs.listCache = null
        console.log(`[files] ${name}: fetched on demand from ${pc.name || pc.pc_id}`)
        return true
      } catch (e) { if (e.status !== 404) console.warn(`[files] ${name} from ${pc.name || pc.pc_id}: ${e.message}`) }
    }
    missed.set(name, Date.now())
    return false
  })().finally(() => inFlight.delete(name))
  inFlight.set(name, job)
  return within(job, answerWithinMs)
}

export const _reset = () => { inFlight.clear(); missed.clear() }
