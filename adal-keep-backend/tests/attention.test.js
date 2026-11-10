import test from 'node:test'
import assert from 'node:assert/strict'

test('an Enjaz captcha goes to the PC first: the phones are told to wait, then it is theirs too', async () => {
  const { askCaptcha, waiting, answerCaptcha } = await import('../src/services/attention.js')
  let typed = null
  askCaptcha(901, 'data:image/png;base64,AAAA', async (t) => { typed = t }, { title: 'Type the captcha', phoneAfterMs: 200 })
  let w = waiting().find(x => x.run_id === 901)
  assert.ok(w.asks && w.image)
  assert.ok(w.phone_wait_ms > 0)                       // phones: not yet
  await new Promise(r => setTimeout(r, 260))
  w = waiting().find(x => x.run_id === 901)
  assert.equal(w.phone_wait_ms, 0)                     // now the phones too
  await answerCaptcha(901, ' 4821 ')
  assert.equal(typed, '4821')
  assert.equal(waiting().find(x => x.run_id === 901), undefined)   // answered: the notice is gone
  askCaptcha(902, null, async () => {}, {})             // other robots: everyone at once
  assert.equal(waiting().find(x => x.run_id === 902).phone_wait_ms, 0)
})
