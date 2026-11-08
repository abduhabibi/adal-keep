import test from 'node:test'
import assert from 'node:assert/strict'
import { windowOpened, windowsOpen, _reset } from '../src/services/appLife.js'

const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('closing the last window ends Adal Keep after the wait; a reload does not', async () => {
  _reset()
  const ended = []
  const end = (why) => ended.push(why)
  const grace = 60

  // A reload: the page goes and comes back within the wait.
  const gone1 = windowOpened({}, { grace, end })
  gone1()
  await wait(20)
  const gone2 = windowOpened({}, { grace, end })
  await wait(grace + 40)
  assert.equal(ended.length, 0)
  assert.equal(windowsOpen(), 1)

  // Two windows: closing one keeps it alive.
  const gone3 = windowOpened({}, { grace, end })
  gone2()
  await wait(grace + 40)
  assert.equal(ended.length, 0)

  // The last one closes: everything ends, once.
  gone3()
  await wait(grace + 40)
  assert.equal(ended.length, 1)
  _reset()
})

test('started with Windows and no window ever opened: nothing ends', async () => {
  _reset()
  assert.equal(windowsOpen(), 0)
  await wait(30)
  assert.equal(windowsOpen(), 0) // no timer runs until a window has been open
  _reset()
})
