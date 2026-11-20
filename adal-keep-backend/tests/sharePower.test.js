import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, isWeak, score } from '../src/services/sharePower.js'

const oldMain = { id: '', name: 'Office PC', cores: 2, mem_gb: 4, free_gb: 0.9, load: 70 }
const strongMain = { id: '', name: 'Office PC', cores: 8, mem_gb: 16, free_gb: 8, load: 20 }
const laptop = { id: 'L', name: 'Laptop', cores: 8, mem_gb: 16, free_gb: 6, load: 40 }        // someone works on it
const oldCompanion = { id: 'O', name: 'Old PC', cores: 2, mem_gb: 4, free_gb: 1, load: 60 }
const busyLaptop = { ...laptop, load: 95 }

test('an old 4 GB PC gives its robot to the strong laptop, even while someone works on the laptop', () => {
  assert.deepEqual(choose({ from: '', pcs: [oldMain, laptop] }), { to: 'L', help: true })
  assert.deepEqual(choose({ from: 'O', pcs: [strongMain, oldCompanion, laptop] }).help, true)
})

test('a strong PC keeps its own work', () => {
  assert.deepEqual(choose({ from: '', pcs: [strongMain, laptop] }), { to: '', help: false })
  assert.deepEqual(choose({ from: 'L', pcs: [oldMain, laptop] }), { to: 'L', help: false })
})

test('nobody stronger and free enough: it stays where it is', () => {
  assert.deepEqual(choose({ from: '', pcs: [oldMain, oldCompanion] }), { to: '', help: false })
  assert.deepEqual(choose({ from: '', pcs: [oldMain, busyLaptop] }), { to: '', help: false })   // the laptop is at 95 %
})

test('a PC already doing many runs is less strong; the next one goes elsewhere', () => {
  const desk = { id: 'D', name: 'Desk', cores: 4, mem_gb: 8, free_gb: 4, load: 30 }
  assert.equal(choose({ from: '', pcs: [oldMain, laptop, desk] }).to, 'L')
  assert.equal(choose({ from: '', pcs: [oldMain, laptop, desk], running: { L: 4 } }).to, 'D')
})

test('the main PC is not used when it may not be (its browser closed, nobody asked)', () => {
  assert.deepEqual(choose({ from: 'O', pcs: [strongMain, oldCompanion], mainAllowed: false }), { to: 'O', help: false })
  assert.deepEqual(choose({ from: 'O', pcs: [strongMain, oldCompanion] }), { to: '', help: true })
})

test('a Companion that does not say how strong it is (an older one) is never given work', () => {
  const unknown = { id: 'U', name: 'Unknown', cores: 16 }
  assert.ok(isWeak(unknown))
  assert.deepEqual(choose({ from: '', pcs: [oldMain, unknown] }), { to: '', help: false })
})

test('on battery counts less; the run it came from is not lost when its PC is gone', () => {
  assert.ok(score({ ...laptop, battery: true }) < score(laptop))
  assert.deepEqual(choose({ from: 'gone', pcs: [oldMain, laptop] }), { to: 'gone', help: false })
})
