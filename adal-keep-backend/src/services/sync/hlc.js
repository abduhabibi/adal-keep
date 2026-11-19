/**
 * hlc.js — a hybrid logical clock: every change made on any PC of the agency
 * gets a stamp that sorts the same way on every PC.
 *
 *   "0001789912345678.0003.a1b2c3d4e5f6"
 *    physical ms (16)  count  the PC that made it
 *
 * Plain strings: comparing two stamps is comparing two strings. The physical
 * part never goes back on this PC (a clock set back gains nothing), and a
 * stamp from another PC moves it forward, so a change made here after seeing
 * one from another PC always sorts after it. The PC id breaks ties, the same
 * way everywhere.
 *
 * A PC whose clock runs far ahead would drag everyone forward: a stamp more
 * than MAX_AHEAD ahead of this PC's clock is still taken (the entry is kept,
 * never refused) but does not move this clock past now + MAX_AHEAD.
 */
export const MAX_AHEAD = 10 * 60 * 1000

const pad = (n, w) => String(n).padStart(w, '0')
export const make = (l, c, pc) => `${pad(l, 16)}.${pad(c, 4)}.${pc}`
export function parse(s) {
  const m = /^(\d{16})\.(\d{4,})\.([\w-]+)$/.exec(String(s || ''))
  return m ? { l: Number(m[1]), c: Number(m[2]), pc: m[3] } : null
}
export const physical = (s) => parse(s)?.l || 0

export class Clock {
  constructor(pc, last = '', now = () => Date.now()) {
    this.pc = pc
    this.now = now
    const p = parse(last)
    this.l = p ? p.l : 0
    this.c = p ? p.c : 0
  }
  /** A stamp for a change made on this PC at `at` (ms; the trigger's time). */
  tick(at = this.now()) {
    const pt = Math.max(Number(at) || 0, 0)
    if (pt > this.l) { this.l = pt; this.c = 0 } else this.c++
    if (this.c > 9999) { this.l++; this.c = 0 }
    return make(this.l, this.c, this.pc)
  }
  /** A stamp seen from another PC: this clock never sorts behind it again. */
  recv(stamp) {
    const p = parse(stamp)
    if (!p) return
    const cap = this.now() + MAX_AHEAD
    const l = Math.min(p.l, cap)
    if (l > this.l) { this.l = l; this.c = p.l > cap ? 0 : p.c }
    else if (l === this.l && p.l <= cap && p.c > this.c) this.c = p.c
  }
  get last() { return make(this.l, this.c, this.pc) }
}
