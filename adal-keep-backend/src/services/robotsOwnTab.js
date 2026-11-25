/**
 * robotsOwnTab.js — a tab a finished run left, where no person ever clicked or typed: what stands in its boxes is the
 * robot's own (its search, the form it filled), so the next run may use it. After a restart that text was taken for a
 * person's and every run opened a tab of its own (2026-11-25, Main: three Musaned tabs). Off: ADAL_OWN_TABS=0.
 */
/** @param st { name, touched } of the tab  @param busy the runs not finished (pending, running, paused) */
export function robotsOwnTab(st, busy, env = process.env) {
  if (env.ADAL_OWN_TABS === '0' || !st || !busy) return false
  const run = /^adal-run-(\d+)$/.exec(st.name || '')?.[1]
  return !!run && !st.touched && !busy.has(Number(run))
}
