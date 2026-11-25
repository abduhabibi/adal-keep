/**
 * bestTab.js — which of a site's tabs a run takes first: one on the pages behind the sign-in (Musaned's dashboard, HR
 * Pool …), then any other, a sign-in page last (2026-11-25, Main: a run opened /login with signed-in tabs beside it).
 * Off: ADAL_BEST_TAB=0.
 */
const INSIDE = /^\/(dashboard|hr-pool|employment-requests|organizations|worker-transfer)\b/
const OUTSIDE = /\/(login|auth|signin|sign-in|account\/login)\b|openid-connect/i
export function tabRank(url, env = process.env) {
  if (env.ADAL_BEST_TAB === '0') return 0
  try { const u = new URL(url); return OUTSIDE.test(u.pathname) ? -1 : INSIDE.test(u.pathname) ? 1 : 0 } catch { return -1 }
}
