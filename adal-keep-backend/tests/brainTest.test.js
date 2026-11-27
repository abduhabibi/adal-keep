// "The robot brain runs on every PC, and Main can be off" (scripts/brain-test.mjs): the five scenarios on the reference brain pass, a brain
// that breaks a rule is caught by the right scenario, and the real-code adapter says which parts are not built yet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startMockSite } from '../scripts/brain/mocksite.mjs'
import { SCENARIOS } from '../scripts/brain/scenarios.mjs'
import { makeReferenceBrain } from '../scripts/brain/reference.mjs'
import { makeRealBrain } from '../scripts/brain/real.mjs'

const runOne = async (make, i) => {
  const site = await startMockSite(), brain = await make({ site })
  try { await SCENARIOS[i][1](brain, site); return 'PASS' } catch (e) { return e.notBuilt ? 'BLOCKED' : `FAIL: ${e.message}` } finally { await brain.close(); await site.close() }
}
const ref = (broken = '') => (o) => makeReferenceBrain({ ...o, broken })

for (const [i, [name]] of SCENARIOS.entries()) test(`reference brain: ${name}`, { timeout: 40000 }, async () => assert.equal(await runOne(ref(), i), 'PASS'))

test('a brain without claims is caught by scenario 3; one that retries by itself is caught by scenario 4', { timeout: 60000 }, async () => {
  assert.match(await runOne(ref('no-claims'), 2), /^FAIL: two PCs never ran her at the same time/)
  assert.match(await runOne(ref('auto-retry'), 3), /^FAIL: (on Main her run is expired|nothing started her again by itself)/)   // (a retry is caught whichever assertion sees it first)
})

test('the real adapter exists (run it with node scripts/brain-test.mjs --real)', { timeout: 20000 }, async () => {
  // (the real adapter builds two real servers: it is run by `node scripts/brain-test.mjs --real`, not here)
  assert.equal(typeof makeRealBrain, 'function')
})
