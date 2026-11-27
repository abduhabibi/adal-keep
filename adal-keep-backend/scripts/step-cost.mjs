// The robots' waits, found in the code and ranked per site (no site is touched, nothing runs):
//   node scripts/step-cost.mjs [--all]
// For each site: the 10 biggest fixed waits — sleep(N), a quiet-network wait, a page load with a big timeout, a JEV call — with the
// function they sit in. It reads the SOURCE: these are the longest times a step can cost, not what Main measured (that needs its robots.log).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services')
const SITES = {
  Musaned: ['musanedWorkflow.js', 'musanedContracts.js', 'musanedImport.js'],
  Enjaz: ['mofaVisa.js'],
  Wafid: ['wafidWorkflow.js'],
  Tasheer: ['tasheer.js'],
  LMIS: ['lmisWorkflow.js'],
  Insurance: ['insuranceCertificate.js', 'insuranceFetch.js'],
}
const rows = {}
for (const [site, files] of Object.entries(SITES)) {
  rows[site] = []
  for (const f of files) {
    const lines = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n')
    let fn = ''
    lines.forEach((l, i) => {
      const m = l.match(/(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=\s*async/); if (m) fn = m[1] || m[2]
      let hit
      if ((hit = l.match(/\bsleep\((\d{3,6})\)/))) rows[site].push({ ms: +hit[1], kind: 'fixed sleep', f, line: i + 1, fn, code: l.trim().slice(0, 110) })
      else if (/networkidle|waitForNetworkIdle/.test(l)) rows[site].push({ ms: /idleTime:\s*(\d+)/.test(l) ? +RegExp.$1 + 0 : 25000, kind: 'quiet-network wait', f, line: i + 1, fn, code: l.trim().slice(0, 110) })
      else if (/page\.goto\(/.test(l)) rows[site].push({ ms: +(l.match(/timeout:\s*(\w+)/) || [])[1] || 0, kind: 'page load', f, line: i + 1, fn, code: l.trim().slice(0, 110) })
      else if (/jev|classifyWithJev|chooseOnPage/i.test(l) && !/^\s*(\/\/|\*)/.test(l)) rows[site].push({ ms: 2500, kind: 'JEV call', f, line: i + 1, fn, code: l.trim().slice(0, 110) })
    })
  }
}
const all = process.argv.includes('--all')
for (const [site, list] of Object.entries(rows)) {
  const top = list.filter(r => all || r.kind !== 'page load' || r.ms >= 60000).sort((a, b) => b.ms - a.ms).slice(0, 10)
  const fixed = list.filter(r => r.kind === 'fixed sleep').reduce((s, r) => s + r.ms, 0)
  console.log(`\n## ${site} — ${list.filter(r => r.kind === 'fixed sleep').length} fixed sleeps in the code, ${(fixed / 1000).toFixed(0)} s if every one ran once`)
  for (const r of top) console.log(`${String(r.ms).padStart(6)} ms  ${r.kind.padEnd(18)} ${r.f}:${r.line}  ${r.fn}  ${r.code}`)
}
