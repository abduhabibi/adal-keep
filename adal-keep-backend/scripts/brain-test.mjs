// "The robot brain runs on every PC, and Main can be off": the five scenarios, one command, PASS / FAIL (BLOCKED = the real code has not built that part yet).
//   node scripts/brain-test.mjs            the reference brain (the contract in docs/CLAIMS.md, brain-test): proves the scenarios are sound
//   node scripts/brain-test.mjs --real     the same scenarios on the real code through scripts/brain/real.mjs
// Exit 0 only when every scenario passed.
import { startMockSite } from './brain/mocksite.mjs'
import { SCENARIOS } from './brain/scenarios.mjs'
const real = process.argv.includes('--real')
process.on('unhandledRejection', (e) => { console.error('unhandled:', e?.message || e) })
const broken = (process.argv.find(a => a.startsWith('--broken=')) || '').slice(9)   // proves the scenarios catch a brain that breaks a rule
const make = real ? (await import('./brain/real.mjs')).makeRealBrain : (o) => import('./brain/reference.mjs').then(m => m.makeReferenceBrain({ ...o, broken }))
let failed = 0, blocked = 0, last = null
console.log(`robot brain on every PC — ${real ? 'REAL code' : 'REFERENCE brain (the contract)'}\n`)
for (const [name, fn] of SCENARIOS) {
  const site = await startMockSite(), t = Date.now()
  let brain = { close: async () => {} }
  let res = 'PASS', why = ''
  try { brain = await make({ site }); last = brain; globalThis.__brainSlack = brain.slackMs || 0; await Promise.race([fn(brain, site), new Promise((_, rej) => setTimeout(() => rej(new Error(`took over ${((brain.timeoutMs || 30000) / 1000)} s`)), brain.timeoutMs || 30000))]) }
  catch (e) { if (e.notBuilt) { res = 'BLOCKED'; why = `not built yet: ${e.message}`; blocked++ } else { res = 'FAIL'; why = e.message; failed++ } }
  finally { await brain.close(); await site.close() }
  console.log(`${res.padEnd(8)} ${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)${why ? `\n         ${why}` : ''}`)
}
await Promise.all([].map(() => 0))
await last?.shutdown?.()
console.log(`\n${failed ? 'FAIL' : blocked ? 'BLOCKED' : 'PASS'} — ${SCENARIOS.length - failed - blocked} passed, ${failed} failed, ${blocked} blocked`)
process.exit(failed || blocked ? 1 : 0)
