import test from 'node:test'
import assert from 'node:assert/strict'
import { pickLeader, lease, hello, nextStep, answerStep, _remoteSourceForTest } from '../src/services/selectionCheck.js'
import { inWaitingPhase } from '../src/routes/automations.js'
import { contractCheck, cancelCheck, cancelable, scanRows } from '../src/services/musanedContracts.js'
import * as phase from '../../adal-keep-frontend/src/lib/phase.js'

test('the strongest PC with Musaned signed in checks: cores first, then free RAM', () => {
  const a = { instance: 'a', cores: 4, free_mb: 8000, musaned: true }
  const b = { instance: 'b', cores: 8, free_mb: 2000, musaned: true }
  const c = { instance: 'c', cores: 16, free_mb: 30000, musaned: false }   // no Musaned tab: never
  assert.equal(pickLeader([a, b, c]).instance, 'b')
  const d = { instance: 'd', cores: 8, free_mb: 6000, musaned: true }
  assert.equal(pickLeader([a, b, d]).instance, 'd')
  assert.equal(pickLeader([c]), null)
})

test('equal PCs: any of them — the one that checked last time keeps it', () => {
  const a = { instance: 'a', cores: 8, free_mb: 4100, musaned: true }
  const b = { instance: 'b', cores: 8, free_mb: 4300, musaned: true }   // the same whole GB
  assert.equal(pickLeader([a, b], 'b').instance, 'b')
  assert.equal(pickLeader([a, b], 'a').instance, 'a')
  assert.ok(['a', 'b'].includes(pickLeader([a, b]).instance))
})

test('Waiting: on Musaned, not chosen, nothing later done, not UNFIT — backend and page agree', () => {
  const cases = [
    [{ cv: 'done', musaned: 'waiting' }, {}, true],
    [{ cv: 'done', musaned: 'done' }, {}, true],                      // chosen, then cancelled: waits again
    [{ musaned: 'waiting' }, {}, true],                               // CV skipped
    [{ cv: 'done', musaned: 'waiting', selected: 'done' }, {}, false], // chosen
    [{ cv: 'done' }, {}, false],
    [{ cv: 'done', musaned: 'waiting' }, { status: 'medical_rejected' }, false],
    [{ cv: 'done', musaned: 'waiting' }, { status: 'medical_fit' }, false],
    [{ cv: 'done', musaned: 'waiting', epro: 'done' }, {}, false],
  ]
  for (const [steps, p, want] of cases) {
    assert.equal(inWaitingPhase(steps, p), want, JSON.stringify([steps, p]))
    assert.equal(phase.inWaitingPhase(steps, p), want, JSON.stringify([steps, p]))
  }
})

test('the tabs: Waiting after Musaned, Unfit apart from Wafid', () => {
  const after = [['Tasheer', 'tasheer', 'Tasheer'], ['Insurance', 'insurance', 'Insurance']]
  const of = (steps, p = {}) => phase.phaseOf(steps, p, after)
  assert.equal(of({}), 'cv')
  assert.equal(of({ cv: 'done' }), 'musaned')
  assert.equal(of({ cv: 'done', musaned: 'waiting' }), 'waiting')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done' }), 'selected')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done', wafid: 'active' }), 'wafid')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done' }, { status: 'medical_applied' }), 'wafid')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done', wafid: 'failed' }, { status: 'medical_rejected' }), 'unfit')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done' }, { status: 'medical_fit' }), 'epro')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done', epro: 'done' }, { status: 'medical_fit' }), 'tasheer')
  assert.equal(of({ cv: 'done', musaned: 'done', selected: 'done', epro: 'done', tasheer: 'done', insurance: 'done' }, { status: 'medical_fit' }), 'choices')
})

test('skipped up to the EPRO; after it, only "done" marks', () => {
  const after = [['Tasheer', 'tasheer', 'Tasheer'], ['Insurance', 'insurance', 'Insurance']]
  assert.deepEqual(phase.stepMarks({ musaned: 'waiting', selected: 'done' }, {}, after), { skipped: ['CV'], done: [] })
  assert.deepEqual(phase.stepMarks({ cv: 'done', epro: 'done', insurance: 'done' }, {}, after), { skipped: ['Musaned', 'Selected', 'Wafid'], done: ['Insurance'] })
  assert.deepEqual(phase.stepMarks({ cv: 'done', musaned: 'done', selected: 'done', epro: 'done' }, { status: 'medical_fit' }, after), { skipped: [], done: [] })
})

test('a Companion holding the lease reads Musaned step by step; another PC gets nothing', async () => {
  Object.assign(lease, { holder: 'pc-b', name: 'PC B', token: 'tok', until: Date.now() + 60000 })
  const src = _remoteSourceForTest('tok', 'PC B', cancelable)
  assert.deepEqual(hello({ instance: 'pc-b', name: 'PC B', cores: 8, free_mb: 4000, musaned: true }), { run: 'tok' })
  assert.equal(hello({ instance: 'pc-c', name: 'PC C', cores: 2, free_mb: 1000, musaned: true }).run, undefined)
  assert.deepEqual(await nextStep('wrong'), { done: true })
  const asked = src.api('/api/search/employment?page=0')
  const job = await nextStep('tok')
  assert.equal(job.kind, 'api')
  assert.equal(job.args.url, '/api/search/employment?page=0')
  assert.deepEqual(answerStep('tok', { id: job.id, ok: true, result: { status: 200, json: { content: [] } } }), { ok: true })
  assert.deepEqual(await asked, { status: 200, json: { content: [] } })
  const pdf = src.pdf('template.pdf')
  const j2 = await nextStep('tok')
  answerStep('tok', { id: j2.id, ok: true, result: Buffer.from('%PDF-1').toString('base64') })
  assert.equal((await pdf).toString(), '%PDF-1')
  src.end()
  assert.deepEqual(await nextStep('tok'), { done: true })
  Object.assign(lease, { holder: '', name: '', token: '', until: 0 })
})

test('Cancel stops the check at once, even a step still waiting', async () => {
  contractCheck.running = true
  contractCheck.cancel = ''
  const never = cancelable(new Promise(() => {}))
  assert.equal(cancelCheck('Cancelled'), true)
  await assert.rejects(never, /Cancelled/)
  // The list read stops at its next step.
  const src = { api: async () => { throw new Error('must not be asked') } }
  await assert.rejects(scanRows({}, src, {}).catch(e => { throw e }), (e) => e.cancelled === true)
  contractCheck.running = false
  contractCheck.cancel = ''
})
