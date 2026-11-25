/**
 * What every screen warns about (components/SafetyAlerts.jsx), worked out from
 * GET /api/safety — the same answer on the main PC, a Companion, a phone (the
 * online copy) and Adal Keep Admin's windows.
 */
const H = 3600 * 1000
export const BACKUP_STALE_MS = 48 * H
export const LICENCE_STEPS = [
  { ms: 7 * 24 * H, label: '7 days' },
  { ms: 3 * 24 * H, label: '3 days' },
  { ms: 24 * H, label: '1 day' },
  { ms: 12 * H, label: '12 hours' },
]

/** How old the newest good backup is when that is a warning (> 48 h), else null. */
export function backupWarning(backup, now = Date.now()) {
  if (!backup) return null
  const at = Date.parse(backup.last_good_at || '') || 0
  if (at) return now - at > BACKUP_STALE_MS ? { since: at, hours: Math.floor((now - at) / H) } : null
  // Never backed up: a warning once it has had 48 h to make one.
  const since = Date.parse(backup.since || '') || 0
  return since && now - since > BACKUP_STALE_MS ? { since: null, hours: Math.floor((now - since) / H), never: true } : null
}

/**
 * The licence warning step reached now: the smallest of 7 d / 3 d / 1 d / 12 h
 * that the time left is under. null when more than 7 days are left, when it
 * has no end (paid for good) or when it has ended (Settings says so).
 */
export function licenceStep(licence, now = Date.now()) {
  const end = Date.parse(licence?.expires_at || '') || 0
  if (!end || licence?.suspended) return null
  const left = end - now
  if (left <= 0) return null
  let step = null
  for (const s of LICENCE_STEPS) if (left <= s.ms) step = s
  return step ? { ...step, left, end, key: `${new Date(end).toISOString()}|${step.label}` } : null
}

export function leftText(ms) {
  if (ms >= 2 * 24 * H) return `${Math.floor(ms / (24 * H))} days`
  if (ms >= 24 * H) return '1 day'
  const h = Math.max(1, Math.round(ms / H))
  return `${h} hour${h > 1 ? 's' : ''}`
}

export function ageText(hours) {
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`
}

// Each licence step shows once on this device (Main, a Companion, a phone, Admin each).
const SHOWN = 'adal-licence-steps-shown'
export function stepShown(key) {
  try { return !!JSON.parse(localStorage.getItem(SHOWN) || '{}')[key] } catch { return false }
}
export function markStepShown(key) {
  try {
    const m = JSON.parse(localStorage.getItem(SHOWN) || '{}')
    m[key] = Date.now()
    // Only the newest few (a renewal starts new steps).
    const keep = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12)
    localStorage.setItem(SHOWN, JSON.stringify(Object.fromEntries(keep)))
  } catch {}
}
