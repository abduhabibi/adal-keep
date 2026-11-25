/**
 * May "Make Musaned" be asked for her? Never while a Musaned run of hers is in
 * line, working or waiting for a person, nor once she is on Musaned (or with
 * another agency there): her state is shown instead. The answer is the server's:
 * two PCs at once are settled by the main PC, which keeps who asked first for a
 * minute (until the run's own row has come to every PC).
 *
 * Only an aid: any error here leaves everything as it was. Off: ADAL_MUSANED_ASK=0.
 */
import { journeyOf } from '../routes/automations.js'
import { isCompanion, mainURL, mainKey } from './mainPC.js'

export const askOn = () => process.env.ADAL_MUSANED_ASK !== '0'
export const CLAIM_MS = 60_000
const claims = new Map()   // profile id → when (the main PC's memory)
const claimed = (id, now = Date.now()) => now - (claims.get(Number(id)) ?? -Infinity) < CLAIM_MS
export const _resetAsk = () => { claims.clear(); down = { url: '', at: 0 } }

const STARTED = { ask: false, state: 'queued', text: 'just started on another PC' }

/** { ask, state: none|queued|working|waiting|failed|on|elsewhere, text } from her own runs and Musaned's stage. */
export async function musanedState(db, id) {
  const p = await db('profiles').where('id', Number(id)).first()
  if (!p) return null
  const runs = {}
  for (const r of await db('automation_queue').where('profile_id', p.id).whereIn('workflow_id', ['musaned_add_candidate', 'musaned_delete'])
    .select('id', 'workflow_id', 'status', 'pause_reason').orderBy('id', 'asc')) runs[r.workflow_id] = r
  const step = journeyOf(p, runs, true).embassy.find(s => s.key === 'musaned')
  const add = runs.musaned_add_candidate
  if (step.state === 'active') return { ask: false, state: add?.status === 'running' ? 'working' : add?.status === 'paused' ? 'waiting' : 'queued', text: step.note }
  if (step.state === 'waiting' || step.state === 'done') return { ask: false, state: 'on', text: `on Musaned, ${step.note}` }
  if (/another agency/i.test(p.musaned_stage || '') && step.state === 'failed') return { ask: false, state: 'elsewhere', text: step.note }
  return { ask: true, state: step.state === 'failed' ? 'failed' : 'none', text: step.state === 'failed' ? step.note : '' }
}

// The main PC not answering is not waited for again for 20 s.
let down = { url: '', at: 0 }
async function askMain(path, { method = 'GET', body } = {}, fetchIt = fetch) {
  const main = mainURL()
  if (down.url === main && Date.now() - down.at < 20_000) return null
  try {
    const r = await fetchIt(`${main}/api${path}`, {
      method, headers: { 'x-adal-pc': await mainKey(), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return null   // (an older main PC, or a girl it does not have yet)
    const j = await r.json()
    return typeof j?.ask === 'boolean' ? j : null
  } catch { down = { url: main, at: Date.now() }; return null }
}

/** What the page shows: here first (a "no" needs nobody else), then the main PC's word. */
export async function askState(db, id, { companion = isCompanion(), fetchIt } = {}) {
  const here = await musanedState(db, id)
  if (!here?.ask) { claims.delete(Number(id)); return here }   // (its run is here: no need to remember who asked)
  if (companion) return (await askMain(`/profiles/${Number(id)}/musaned-state`, {}, fetchIt)) || here
  return claimed(id) ? { ...STARTED } : here
}

/** The main PC: the first to ask gets { ask: true }; anyone after it, or too late, gets her state. release: it did not start. */
export async function claimHere(db, id, { release = false } = {}) {
  if (release) { claims.delete(Number(id)); return { ask: true, state: 'none', text: '' } }
  // Taken before anything is waited for, so two asking at once never both get it.
  if (claimed(id)) {
    const s = await musanedState(db, id).catch(() => null)
    if (!s || s.ask) return { ...STARTED }
    claims.delete(Number(id))
    return s
  }
  claims.set(Number(id), Date.now())
  if (claims.size > 500) for (const [k, at] of claims) if (Date.now() - at > CLAIM_MS) claims.delete(k)
  const s = await musanedState(db, id).catch(() => null)   // (not here yet: it can only be the first)
  if (s && !s.ask) { claims.delete(Number(id)); return s }
  return { ask: true, state: 'none', text: '' }
}
export async function claim(db, id, { release = false, companion = isCompanion(), fetchIt } = {}) {
  return companion ? askMain(`/profiles/${Number(id)}/musaned-claim`, { method: 'POST', body: { release } }, fetchIt) : claimHere(db, id, { release })
}

const SAY = { queued: 'in line', working: 'working now', waiting: 'waiting for you', on: 'already on Musaned', elsewhere: 'registered by another agency' }
export const already = (s) => ({ ok: true, already: true, resumed: true, state: s.state, musaned: s, message: `Not started a second time: ${s.text || SAY[s.state] || s.state}` })
