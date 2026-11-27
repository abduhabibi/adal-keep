// Ranks the slowest robot steps per site from robots.log (the `[steps]` lines of services/stepTimes.js):
//   node scripts/step-times.mjs <robots.log> [--top=8]
// Per site: each step's runs, total, mean and slowest time, ranked by total time. "run*" steps are whole runs, listed apart.
// Reads one file, touches no site.
import fs from 'fs'
const file = process.argv.find((a, i) => i > 1 && !a.startsWith('--'))
const top = +(process.argv.find(a => a.startsWith('--top='))?.slice(6) || 8)
if (!file) { console.log('usage: node scripts/step-times.mjs <robots.log> [--top=8]'); process.exit(1) }
const sites = {}
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = l.match(/\[steps\] run=\S* profile=\S* (\S+) (\S+) ([\d.]+) s( failed)?/)
  if (!m) continue
  const [, site, step, s, failed] = m
  const r = ((sites[site] ||= {})[step] ||= { n: 0, total: 0, max: 0, failed: 0 })
  r.n++; r.total += +s; r.max = Math.max(r.max, +s); if (failed) r.failed++
}
if (!Object.keys(sites).length) console.log('no [steps] lines in this log yet')
for (const [site, steps] of Object.entries(sites)) {
  const rows = Object.entries(steps).map(([step, r]) => ({ step, ...r, mean: r.total / r.n }))
  const show = (list) => list.sort((a, b) => b.total - a.total).slice(0, top).forEach(r =>
    console.log(`${r.total.toFixed(0).padStart(7)} s total  ${String(r.n).padStart(4)} runs  mean ${r.mean.toFixed(1).padStart(6)} s  slowest ${r.max.toFixed(1).padStart(6)} s${r.failed ? `  (${r.failed} failed)` : ''}  ${r.step}`))
  console.log(`\n## ${site} — steps`); show(rows.filter(r => !/^run[A-Z]/.test(r.step)))
  const whole = rows.filter(r => /^run[A-Z]/.test(r.step))
  if (whole.length) { console.log(`## ${site} — whole runs`); show(whole) }
}
