import test from 'node:test'
import assert from 'node:assert/strict'

test('plans: what each plan has, and an agency set apart', async () => {
  const { featureState, featureForWorkflow } = await import('../src/services/plans.js')
  assert.equal(featureState('wafid', null), 'on')                    // no licence yet: the trial has everything
  assert.equal(featureState('wafid', { plan: 'basic' }), 'on')       // one plan since 2026-11-23: old basic / standard read as Premium
  assert.equal(featureState('enjaz_visa', { plan: 'standard' }), 'on')
  assert.equal(featureState('enjaz_visa', { plan: 'premium' }), 'on')
  assert.equal(featureState('enjaz_visa', { plan: 'basic', features: { enjaz_visa: 'on' } }), 'on')
  assert.equal(featureState('wafid', { plan: 'premium', features: { wafid: 'off' } }), 'off')
  assert.equal(featureState('insurance', { plan: 'basic', offers: [{ feature: 'insurance' }] }), 'on')   // (every agency is Premium: nothing is left to offer)
  assert.equal(featureForWorkflow('musaned_check_chosen'), null)   // checking who was chosen: every plan
  assert.equal(featureForWorkflow('mofa_visa').key, 'enjaz_visa')
})

test('plans: a licence not signed by Adal is refused', async () => {
  const { verifyLicense } = await import('../src/services/plans.js')
  const license = { pc: '123455', plan: 'premium', paid_until: Date.now() + 1e10 }
  assert.equal(verifyLicense({ license, signature: Buffer.alloc(64).toString('base64') }, '123455'), null)
  assert.equal(verifyLicense({ license }, '123455'), null)
})
