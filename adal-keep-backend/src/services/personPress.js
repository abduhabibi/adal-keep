/**
 * personPress.js — is this a run a person asked for? A run the scanner found by itself never opens the robot browser;
 * one a person pressed (Start, Continue, Put back in line, Run next) does, out of sight, and stays a person's run
 * through every restart (2026-11-25, Main: two runs a person had pressed waited for ever, "Waiting for Adal Browser
 * to be open", because that wait itself was read as "nobody asked").
 */
const WAITING = /^(Retry |Waiting for )/

/** A run only the scanner asked for. job: a row of automation_queue. */
export const nobodyAsked = (job) => !/"asked_at"/.test(String(job?.context || '')) && /Auto-discovered by scanner/.test(String(job?.log || ''))

/** A person pressed it: written on the run; a wait it was in ends now. */
export async function personAsked(db, row, now = Date.now()) {
  let ctx = {}
  try { ctx = JSON.parse(row.context || '{}') || {} } catch { return false }
  const { seal } = await import('./accountVault.js')
  await db('automation_queue').where('id', row.id).whereIn('status', ['pending', 'paused']).update({
    context: seal(JSON.stringify({ ...ctx, asked_at: now })),
    ...(WAITING.test(row.pause_reason || '') ? { pause_reason: null, updated_at: new Date(now).toISOString() } : {}),
  })
  return true
}
