/**
 * rollout.js — a release reaches agencies in stages (asked on 2026-11-23):
 * the test agency first, then about 10% of agencies, then everyone, with a
 * hold time between the stages, and Adal Keep Admin can advance or stop it.
 *
 * The plan is signed inside the manifest (docs/updates-v2.md §3):
 *   rollout: { test: [agency ids], pct: 10, pct_at, everyone_at, stopped }
 * An office is one unit (its PCs share one database): the 10% are agencies,
 * chosen by a hash of the release and the agency, so it is another 10% each time.
 * Admin advancing or stopping re-signs latest.json (same sha) on Adal's PC.
 * The same rule is in adal-companion/selfupdate.go (itsTurn).
 */
import crypto from 'crypto'

const ms = (v) => { const n = Date.parse(String(v || '')); return Number.isFinite(n) ? n : 0 }
export const FAR = '9999-12-31T00:00:00.000Z'

/** 0..99 for this release and agency (unknown agency: 99, the last). */
export function bucket(sha, agency) {
  if (!agency) return 99
  return crypto.createHash('sha256').update(`adal-rollout|${sha}|${agency}`).digest().readUInt32BE(0) % 100
}

/** Whether this agency may take the release from Supabase now. */
export function itsTurn(m, agency, now = Date.now()) {
  const r = m?.rollout
  if (!r) { // older releases: "updates first" agencies at once, everyone else at everyone_at
    if (!m?.everyone_at || ms(m.everyone_at) <= now) return true
    return !!agency && (m.early || []).includes(agency)
  }
  if (r.stopped) return false
  if (agency && (r.test || []).includes(agency)) return true
  if (ms(r.everyone_at) && ms(r.everyone_at) <= now) return true
  if (ms(r.pct_at) && ms(r.pct_at) <= now && bucket(m.sha, agency) < (Number(r.pct) || 0)) return true
  return false
}

/** When this agency's turn comes (ISO), or null when it is now / stopped (then: 'stopped'). */
export function turnAt(m, agency, now = Date.now()) {
  if (itsTurn(m, agency, now)) return null
  const r = m?.rollout
  if (!r) return m?.everyone_at || null
  if (r.stopped) return 'stopped'
  if (ms(r.pct_at) > now && bucket(m.sha, agency) < (Number(r.pct) || 0)) return r.pct_at
  return r.everyone_at || null
}

/** The stage now: 'test' | 'pct' | 'everyone' | 'stopped'. */
export function stageOf(m, now = Date.now()) {
  const r = m?.rollout
  if (!r) return !m?.everyone_at || ms(m.everyone_at) <= now ? 'everyone' : 'test'
  if (r.stopped) return 'stopped'
  if (ms(r.everyone_at) <= now) return 'everyone'
  if (ms(r.pct_at) <= now) return 'pct'
  return 'test'
}

/** A new plan for publish-update.mjs: test now, pct after holdHours, everyone after 2 × holdHours. */
export function newRollout({ test = [], pct = 10, holdHours = 2, now = Date.now(), at = null } = {}) {
  const h = Number(holdHours) * 3600 * 1000
  if (at === 'now') return { test, pct, pct_at: new Date(now).toISOString(), everyone_at: new Date(now).toISOString(), stopped: false }
  return { test, pct, pct_at: new Date(now + h).toISOString(), everyone_at: new Date(now + 2 * h).toISOString(), stopped: false }
}

/**
 * The manifest with its plan changed (signed again by the caller):
 *   'advance' — the next stage now; 'stop' — nobody new takes it; 'resume' — on again
 *   (the stages not yet reached keep their hold time from now); 'everyone' — all now.
 * `early` / `everyone_at` follow for older PCs.
 */
export function changeRollout(m, action, now = Date.now()) {
  const r = { ...(m.rollout || newRollout({ test: m.early || [], now: ms(m.published_at) || now })) }
  const iso = new Date(now).toISOString()
  const stage = stageOf({ ...m, rollout: r }, now)
  if (action === 'stop') r.stopped = true
  else if (action === 'resume') {
    const hold = Math.max(0, ms(r.everyone_at) - ms(r.pct_at)) || 2 * 3600 * 1000
    r.stopped = false
    if (ms(r.pct_at) < now && ms(r.everyone_at) > now) r.everyone_at = new Date(Math.max(ms(r.everyone_at), now + hold)).toISOString()
  } else if (action === 'advance') {
    r.stopped = false
    if (stage === 'test' || stage === 'stopped' && ms(r.pct_at) > now) r.pct_at = iso
    else r.everyone_at = iso
  } else if (action === 'everyone') { r.stopped = false; r.pct_at = r.pct_at && ms(r.pct_at) < now ? r.pct_at : iso; r.everyone_at = iso }
  else throw new Error(`unknown rollout action: ${action}`)
  return {
    ...m, rollout: r,
    early: r.stopped ? [] : (r.test || []),
    everyone_at: r.stopped ? FAR : r.everyone_at,
  }
}

/** Windows on this PC: 'x86' (32-bit) or 'x64'. Off Windows: the Node build's own. */
export function pcArch(env = process.env, nodeArch = process.arch) {
  if (process.platform === 'win32' || env.PROCESSOR_ARCHITECTURE) {
    const a = String(env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || '').toUpperCase()
    if (a === 'X86') return 'x86'
    if (a) return 'x64'
  }
  return nodeArch === 'ia32' ? 'x86' : 'x64'
}

/**
 * The programs this PC installs: the 64-bit ones, or on 32-bit Windows the
 * GOARCH=386 builds (none in the release: none — never a 64-bit one there).
 */
export function programsFor(m, arch = pcArch()) {
  if (arch === 'x86') return { list: Array.isArray(m?.programs_x86) ? m.programs_x86 : [], missing: !(m?.programs_x86 || []).length && (m?.programs || []).length > 0 }
  return { list: m?.programs || [], missing: false }
}
