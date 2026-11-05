import test from 'node:test'
import assert from 'node:assert/strict'
import { needPerson, askCaptcha, doneWith, waiting, answerCaptcha } from '../src/services/attention.js'

test('a code with no picture is asked in the bar, sent once, and can be asked again', async () => {
  const got = []
  needPerson(1, 'Musaned code')
  askCaptcha(1, null, (t) => got.push(t), { title: 'Type the Musaned code', label: 'Code' })
  let c = waiting().find(w => w.run_id === 1)
  assert.equal(c.asks, true); assert.equal(c.label, 'Code'); assert.equal(c.image, null)
  await answerCaptcha(1, ' 123456 ')
  assert.deepEqual(got, ['123456'])
  assert.equal(waiting().find(w => w.run_id === 1).asks, false)
  await assert.rejects(answerCaptcha(1, '1'))
  askCaptcha(1, null, (t) => got.push(t), { title: 'That code was not accepted' })
  c = waiting().find(w => w.run_id === 1)
  assert.equal(c.title, 'That code was not accepted'); assert.equal(c.asks, true)
  doneWith(1)
  assert.equal(waiting().some(w => w.run_id === 1), false)
})

test('a confirmation stays after the run ends, until the person says done', () => {
  needPerson(2, 'Press SAVE', '', { confirm: true })
  doneWith(2)
  assert.equal(waiting().find(w => w.run_id === 2).confirm, true)
  doneWith(2, { force: true })
  assert.equal(waiting().some(w => w.run_id === 2), false)
})

test('a paused run keeps its question', () => {
  askCaptcha(3, null, () => {})
  doneWith(3, { keepCaptcha: true })
  assert.equal(waiting().find(w => w.run_id === 3).asks, true)
  doneWith(3)
})
