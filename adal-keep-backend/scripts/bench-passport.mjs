// Times the passport's local reading steps on a sample page (no network, no keys).
//   node scripts/bench-passport.mjs [image]
import path from 'path'
import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] || path.join(here, '..', 'tests', 'fixtures', 'sample-passport.jpg')
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[k]
const t = () => performance.now()
const q = await import('../src/services/quickMrz.js')
let a = t(); await q.warmMrzReader?.(); const warm = t() - a
a = t(); const r1 = await q.quickMrz(file, { tries: 1 }); const first = t() - a
a = t(); const r2 = await q.quickMrz(file, { tries: 1 }); const second = t() - a
const { analyzeWithMineru } = await import('../src/services/mineruClassifier.js')
a = t(); const r3 = await analyzeWithMineru(file, { placeLater: true }); const full = t() - a
console.log(JSON.stringify({ warm: Math.round(warm), first: Math.round(first), second: Math.round(second), full: Math.round(full), number: r1?.fields?.passport_number, ok: !!r2, src: r3?.source }))
process.exit(0)
