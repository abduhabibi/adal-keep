/**
 * What a run's failure means, in words a person can act on. A run stores the
 * raw error; the journey, the status page and the profile's notes all say this.
 */
const REASONS = [
  [/Profile is missing for \w+: (.+)/i, (m) => `missing on the profile: ${m[1]}`],
  [/No Bank Account Found/i, () => 'LMIS blocks this agency: it has no bank account there'],
  [/rejected the credentials|invalid (username|password)/i, () => 'the site refused the sign-in: check the password'],
  [/stays signed in as/i, () => 'the site stayed signed in to another account'],
  [/no Delete for her/i, () => 'Musaned has no Delete for her: she may have a contract or a request'],
  [/still shows her after Delete/i, () => 'Musaned still shows her after Delete'],
  [/shows \d+ rows for passport/i, () => 'Musaned shows more than one row for her passport'],
  [/this PC's internet was working/i, () => "the site did not answer, and this PC's internet was working"],
  [/this PC's internet was down/i, () => "this PC's internet was down"],
  [/Could not reach|net::ERR|ERR_[A-Z_]+|Navigation timeout|timed? ?out|Could not determine login state/i, () => 'the site was not available'],
  [/Worker card not found/i, () => 'she was not found on the site'],
  [/(\S.*) not found/i, (m) => `the site changed: ${m[1]} was not there`],
  [/detached|Target closed|Session closed|context was destroyed|Protocol error|Cannot read properties/i, () => 'the page changed while it was working'],
]

/** The stored reason without the worker's "Retry 1/3 at …" and "(after 3 attempts)". */
const bare = (text) => String(text || '').replace(/^Retry \d+\/\d+ at \S+ — /, '').replace(/ \(after \d+ attempts?\)$/, '').trim()

const NETWORK = /Could not reach|net::ERR|ERR_[A-Z_]+|Navigation timeout|timed? ?out/i

/** A network failure says whose it was: this PC's internet or the site's. */
export async function withInternetCheck(text, probe = () => fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(6000) })) {
  if (!NETWORK.test(text)) return text
  const up = await probe().then(() => true).catch(() => false)
  return `${text} — ${up ? "this PC's internet was working" : "this PC's internet was down"}`
}

export function plainReason(text) {
  const raw = bare(text)
  if (!raw) return 'last run failed'
  for (const [re, say] of REASONS) { const m = raw.match(re); if (m) return say(m) }
  return raw.slice(0, 90)
}

const WORKFLOWS = {
  musaned_add_candidate: 'Musaned', musaned_delete: 'Delete from Musaned', musaned_check_chosen: 'Musaned check', musaned_cv_import: 'Musaned CV',
  wafid_book: 'Wafid', lmis: 'LMIS', lmis_contract: 'LMIS contract', contract_import_labour: 'LMIS contract', delete_labour: 'LMIS delete',
  police_certificate: 'Police certificate', insurance_certificate: 'Insurance', tasheer_schedule: 'Tasheer', mofa_visa: 'Enjaz visa', mofa_find_app: 'Enjaz',
}
export const workflowName = (id) => WORKFLOWS[id] || String(id || '').replace(/_/g, ' ')

/**
 * Her last failure still standing: the newest workflow whose latest run failed,
 * leaving out steps since done some other way (`settled`: workflow ids) and old
 * ones, whose cause is usually long gone (the failed step still shows on her journey).
 */
export function problemOf(runs = {}, settled = new Set(), now = Date.now()) {
  const recent = (r) => !r.finished_at || now - new Date(r.finished_at).getTime() < 14 * 86400_000
  const failed = Object.values(runs).filter(r => r?.status === 'failed' && !settled.has(r.workflow_id) && recent(r)).sort((a, b) => b.id - a.id)[0]
  if (!failed) return ''
  const name = workflowName(failed.workflow_id)
  return `${name}: ${plainReason(failed.pause_reason).replace(new RegExp(`^${name}: `), '')}`
}

/** A finished Delete (or "she is not there") outranks what came before it; a later add outranks that. */
export function goneFromMusaned(runs = {}) {
  const del = runs.musaned_delete, add = runs.musaned_add_candidate
  return del?.status === 'done' && !(add?.status === 'done' && add.id > del.id)
}
