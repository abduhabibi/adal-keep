// Is this file a passport? time per file and false yes / false no, on made-up files only (scripts/passport-set.mjs):
//   unshare -rn taskset -c 0,1 node scripts/bench-passport-detect.mjs [rounds=3]
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeSet } from './passport-set.mjs'
const { analyzeLocalPassport } = await import('../src/services/passportOnly.js')
const { warmMrzReader } = await import('../src/services/quickMrz.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pset-'))
const set = await makeSet(dir)
const rounds = Number(process.argv[2]) || 3
const t0 = performance.now(); await warmMrzReader(); console.log(`reader warm in ${Math.round(performance.now() - t0)} ms (the first scan after a start pays this)`)
const times = { yes: [], no: [] }; let falseYes = 0, falseNo = 0
for (let r = 0; r < rounds; r++) for (const f of set) {
  const t = performance.now(); const res = await analyzeLocalPassport(f.file); const ms = Math.round(performance.now() - t)
  const said = res.doc_type === 'Passport'
  ;(f.yes ? times.yes : times.no).push(ms)
  if (r === 0) console.log(`${f.name.padEnd(22)} should be ${f.yes ? 'yes' : 'no '} said ${said ? 'yes' : 'no '} ${said === f.yes ? 'ok ' : '<<< WRONG'} ${ms} ms`)
  if (said && !f.yes) falseYes++
  if (!said && f.yes) falseNo++
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]
console.log(JSON.stringify({ files: set.length, passports: set.filter(f => f.yes).length, rounds, falseYes, falseNo, passport_ms: { p50: q(times.yes, 0.5), p95: q(times.yes, 0.95), max: Math.max(...times.yes) }, other_ms: { p50: q(times.no, 0.5), p95: q(times.no, 0.95), max: Math.max(...times.no) } }))
process.exit(0)
