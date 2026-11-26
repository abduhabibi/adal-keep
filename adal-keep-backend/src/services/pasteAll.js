/**
 * pasteAll.js — the robots paste what is plain text instead of typing it, a whole part of a form in one step (the
 * owner, 2026-11-25, as the insurance robot already does), and wait for the page's own sign instead of a fixed time.
 *
 *   setAll(page, items)   all plain boxes of one part set in one page step (focus, the box's own setter, input, change,
 *                         blur), then every value read back: what is not kept is returned, to be filled the older way,
 *                         alone. A box that is more than text (a search list, a calendar, a number spinner, read-only)
 *                         is never set here. An Angular box that still says "untouched by anyone" (ng-pristine) did not
 *                         hear it: not kept.
 *   waitSign(page, fn)    waits for fn in the page to be true: the fixed sleep of before is the upper limit.
 *   lastKey(page, …)      a search box: the text in one piece, its last letter as a real key (lists that search as you
 *                         type hear key events).
 * Off: ADAL_PASTE_ALL=0 — letter by letter and the fixed waits, as before. Any error: the older way.
 */
export const pasteOn = () => process.env.ADAL_PASTE_ALL !== '0'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export const counts = { set: 0, kept: 0, alone: 0 }

// --- runs in the page ---------------------------------------------------------------------------------------------
/** The <label> with these words (Musaned). */
export function LABEL_IN_PAGE(lbl) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim()
  const target = norm(lbl)
  const labels = Array.from(document.querySelectorAll('label'))
  return labels.find(l => norm(l.textContent) === target) || labels.find(l => norm(l.textContent).includes(target)) || null
}
/** The box of a <label> (Musaned). */
export function INPUT_IN_PAGE(label) {
  const isUsable = (i) => i && !i.disabled && !['radio', 'checkbox', 'file', 'hidden'].includes(i.type)
  const inner = 'input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])'
  const forId = label.getAttribute('for')
  if (forId) {
    const t = document.getElementById(forId)
    if (t) {
      if (t.tagName === 'INPUT' && isUsable(t)) return t
      const i = t.querySelector(inner)
      if (isUsable(i)) return i
    }
    const byCtl = document.querySelector(`[formcontrolname="${forId}"]`)
    if (byCtl) {
      if (byCtl.tagName === 'INPUT' && isUsable(byCtl)) return byCtl
      const i = byCtl.querySelector(inner)
      if (isUsable(i)) return i
    }
  }
  let el = label.nextElementSibling
  for (let i = 0; i < 6 && el; i++) {
    if (el.tagName === 'INPUT' && isUsable(el)) return el
    const inp = el.querySelector?.(inner)
    if (isUsable(inp)) return inp
    el = el.nextElementSibling
  }
  const inp = label.parentElement?.querySelector(inner)
  if (isUsable(inp)) return inp
  let cur = label.parentElement
  for (let i = 0; i < 8 && cur; i++) {
    const x = cur.querySelector('p-datepicker input, p-calendar input, .p-datepicker-input, .p-autocomplete-input, input.p-inputtext, input.form-control')
    if (isUsable(x)) return x
    cur = cur.parentElement
  }
  return null
}
/** A box of text and nothing else. */
export function PLAIN_IN_PAGE(el) {
  if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.disabled || el.readOnly) return false
  if (el.tagName === 'INPUT' && !['text', 'email', 'tel', 'search', 'url', ''].includes(el.getAttribute('type') || '')) return false
  if (/^(combobox|spinbutton|searchbox|listbox)$/.test(el.getAttribute('role') || '') || el.hasAttribute('aria-autocomplete') || el.hasAttribute('list') || el.hasAttribute('ngbdatepicker')) return false
  return !el.closest('p-autocomplete, .p-autocomplete, p-inputnumber, .p-inputnumber, p-datepicker, p-calendar, .p-datepicker, app-calendar, p-select, .p-select, p-dropdown, .p-dropdown, ng-select, .select2-container, .chosen-container, .hasDatepicker, .is-calendarsPicker')
    && !/hasDatepicker|calendarsPicker/i.test(el.className || '') && !el.closest('[class*="captcha" i], [id*="captcha" i]') && !/captcha/i.test(`${el.id} ${el.name}`)
}
/** → { name: 'set' | 'same' | 'kept' | 'none' | 'not-plain' | 'twice' } (data-adal-paste marks what was set) */
function SET_IN_PAGE(items, labelOf, inputOf, plain) {
  const out = {}, seen = new Map(), todo = []
  for (const it of items) {
    let el = null
    if (it.mark) el = document.querySelector(`[data-adal-v="${it.mark}"]`)
    else { const l = labelOf(it.name); el = l && inputOf(l) }
    if (!el) { out[it.name] = 'none'; continue }
    if (!plain(el)) { out[it.name] = 'not-plain'; continue }
    if (seen.has(el)) { out[it.name] = 'twice'; out[seen.get(el)] = 'twice'; continue }
    seen.set(el, it.name)
    todo.push([it, el])
  }
  for (const [it, el] of todo) {
    if (out[it.name] === 'twice') continue
    if (it.keep && el.value) { out[it.name] = 'kept'; continue }
    el.setAttribute('data-adal-paste', it.name)
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    el.focus()
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, it.value)
    for (const t of ['input', 'change', ...(it.keyup ? ['keyup'] : [])]) el.dispatchEvent(new Event(t, { bubbles: true }))
    if (it.keyup && window.jQuery) window.jQuery(el).trigger('change')
    el.blur()
    out[it.name] = 'set'
  }
  return out
}
function READ_IN_PAGE(names) {
  const out = {}
  for (const n of names) {
    const el = [...document.querySelectorAll('[data-adal-paste]')].find(e => e.getAttribute('data-adal-paste') === n)
    out[n] = el ? { v: el.value, pristine: el.classList.contains('ng-pristine') } : null
    el?.removeAttribute('data-adal-paste')
  }
  return out
}

// --- in Node --------------------------------------------------------------------------------------------------------
const trim = (x) => String(x ?? '').trim()
const within = (p, ms) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error('no answer')), ms) })]).finally(() => clearTimeout(t)) }

/**
 * items: [{ name, value, mark?, keep?, keyup? }] — name: the label's words; mark: a data-adal-v already on the box;
 * keep: a box with something in it stays as it is. → { name: 'ok' | 'kept' | 'alone' } ('alone': fill it the older way)
 */
export async function setAll(page, items, { settleMs = 80 } = {}) {
  const out = Object.fromEntries(items.map(i => [i.name, 'alone']))
  const todo = items.filter(i => i.value !== undefined && i.value !== null && String(i.value) !== '').map(i => ({ ...i, value: String(i.value) }))
  if (!pasteOn() || !todo.length) return out
  try {
    const did = await within(page.evaluate(`(${SET_IN_PAGE})(${JSON.stringify(todo)}, ${LABEL_IN_PAGE}, ${INPUT_IN_PAGE}, ${PLAIN_IN_PAGE})`), 8000)   // (one expression: a site that forbids eval does not mind)
    const set = todo.filter(i => did[i.name] === 'set')
    await sleep(settleMs)                              // a mask or a form that puts its own value back has done it
    const now = set.length ? await within(page.evaluate(READ_IN_PAGE, set.map(i => i.name)), 8000) : {}
    for (const i of todo) {
      const r = now[i.name]
      if (did[i.name] === 'kept') out[i.name] = 'kept'
      else if (r && trim(r.v) === trim(i.value) && !r.pristine) out[i.name] = 'ok'
    }
  } catch { /* the older way for all of them */ }
  for (const v of Object.values(out)) { counts.set++; if (v === 'alone') counts.alone++; else counts.kept++ }
  return out
}

/** Waits until fn(arg) in the page is true, at most `max` ms (the fixed wait of before), at least `min`. → true / false */
export async function waitSign(page, fn, arg, max, { min = 0, every = 40 } = {}) {
  if (!pasteOn()) { await sleep(max); return false }
  const t0 = Date.now()
  if (min) await sleep(Math.min(min, max))
  for (;;) {
    let ok = false
    try { ok = !!(await within(page.evaluate(fn, arg), Math.max(200, max))) } catch {}
    if (ok) return true
    const left = max - (Date.now() - t0)
    if (left <= 0) return false
    await sleep(Math.min(every, left))
  }
}
/** waitSign on one element. */
export async function waitOn(handle, fn, arg, max, { every = 25 } = {}) {
  if (!pasteOn()) { await sleep(max); return false }
  const t0 = Date.now()
  for (;;) {
    let ok = false
    try { ok = !!(await within(handle.evaluate(fn, arg), Math.max(200, max))) } catch {}
    if (ok) return true
    if (Date.now() - t0 >= max) return false
    await sleep(Math.min(every, Math.max(5, max - (Date.now() - t0))))
  }
}

/**
 * The text in one piece, its last letter as a key (the box has the focus). Off, or it did not land: letter by letter.
 * input: the box's handle.
 */
export async function lastKey(page, input, text, { delay = 40 } = {}) {
  const v = String(text ?? '')
  if (!pasteOn() || v.length < 2) return input.type(v, { delay })
  try {
    const before = await input.evaluate(e => { e.focus(); return e.value ?? '' })
    await page.keyboard.sendCharacter(v.slice(0, -1))
    await page.keyboard.press(v.slice(-1)).catch(() => page.keyboard.sendCharacter(v.slice(-1)))
    const got = await input.evaluate(e => e.value ?? '')
    if (got === before + v || got === v) return
    // A mask or a limit of its own may show it otherwise (spaces, upper case): the same letters are there.
    const bare = (x) => x.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    if (bare(got).endsWith(bare(v))) return
    await input.evaluate((e, b) => { Object.getOwnPropertyDescriptor(e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, b); e.dispatchEvent(new Event('input', { bubbles: true })); e.focus() }, before)
  } catch { /* typed */ }
  await input.type(v, { delay })
}

// Signs in Musaned's pages (PrimeNG).
const PANELS = '.p-autocomplete-panel, .p-autocomplete-overlay, .p-datepicker-panel, .p-select-overlay, .p-dropdown-panel'
export const NO_PANEL = (sel) => ![...document.querySelectorAll(sel)].some(p => { const r = p.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(p).visibility !== 'hidden' && getComputedStyle(p).display !== 'none' })
export const noPanel = (page, max) => waitSign(page, NO_PANEL, PANELS, max)
/** The list shows, and its first choice is the wanted one (what ↓ Enter / Tab takes). */
export const FIRST_OPTION_IS = (opt) => {
  const bare = (s) => (s || '').replace(/\s+/g, '').toLowerCase()
  const seen = [...document.querySelectorAll('.p-autocomplete-item, .p-autocomplete-option, .p-multiselect-item, .p-select-option, [role="option"]')].filter(o => { const r = o.getBoundingClientRect(); return r.width > 2 && r.height > 2 })
  return seen.length > 0 && bare(seen[0].textContent) === bare(opt)
}

/**
 * After a choice that may make the page ask for the next list: until it has asked nothing for `idle` ms — the fixed
 * wait of before (max) at most. Off: the fixed wait.
 */
export async function quietNet(page, max, idle = 150) {
  if (!pasteOn() || typeof page.waitForNetworkIdle !== 'function') return sleep(max)
  const t0 = Date.now()
  await page.waitForNetworkIdle({ idleTime: Math.min(idle, max), timeout: max }).catch(() => {})
  return Date.now() - t0
}
