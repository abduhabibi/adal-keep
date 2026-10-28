/**
 * pageMirror.js — a run's tab as a light, phone-sized page.
 *
 * mirrorOf(page) reads what a person sees on the tab: headings and text,
 * fields (with their labels and values), lists, ticks, buttons and links, in
 * page order. Pictures and boxes from other sites (captcha images, the
 * reCAPTCHA box) come as small cut-outs of the screen. Every element gets a
 * number that stays the same while the page lives; the phone answers with
 * mirrorInput(page, { kind, id, … }) and the PC does it on the real element
 * as a person would (real keys, real clicks).
 */

const MAX_BLOCKS = 700

// Runs inside the tab. Kept self-contained (it is sent as text).
function readPage() {
  const M = window.__adalM ||= { next: 1, ids: new WeakMap(), els: new Map() }
  const idOf = (el) => {
    let id = M.ids.get(el)
    if (!id) { id = M.next++; M.ids.set(el, id); M.els.set(id, el) }
    return id
  }
  for (const [id, el] of M.els) if (!el.isConnected) M.els.delete(id)

  const vw = innerWidth, vh = innerHeight
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return null
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null
    return r
  }
  const clean = (t, n = 300) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const ROLES = new Set(['button', 'link', 'option', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'combobox', 'treeitem'])
  const used = new Set()           // labels shown with their field

  const labelOf = (el) => {
    const parts = []
    for (const l of el.labels || []) { parts.push(l.innerText); used.add(l) }
    const by = el.getAttribute('aria-labelledby')
    if (by) for (const i of by.split(/\s+/)) { const l = document.getElementById(i); if (l) { parts.push(l.innerText); used.add(l) } }
    return clean(parts.join(' ') || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || '', 120)
  }
  // Mark labels first so they do not show twice.
  document.querySelectorAll('input,select,textarea').forEach(el => labelOf(el))

  const out = []
  const add = (b) => { if (out.length < 900) out.push(b) }
  const clickable = (el, s) => {
    const tag = el.tagName
    if (tag === 'BUTTON' || (tag === 'A' && el.hasAttribute('href')) || tag === 'SUMMARY') return true
    const role = el.getAttribute('role')
    if (role && ROLES.has(role)) return true
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true
    if (s.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') return clean(el.innerText, 81).length <= 80
    return false
  }

  const walk = (el) => {
    if (out.length >= 900) return
    const tag = el.tagName
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|META|LINK)$/.test(tag)) return
    const r = shown(el)
    if (!r) {
      // display:contents and zero-size wrappers can still hold visible children
      if (el.children.length && getComputedStyle(el).display !== 'none') for (const c of el.children) walk(c)
      return
    }
    const s = getComputedStyle(el)
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
    const box = { x: r.left, y: r.top, w: r.width, h: r.height, v: inView }
    const dis = el.disabled || el.getAttribute('aria-disabled') === 'true'

    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'hidden') return
      if (type === 'checkbox' || type === 'radio') return add({ k: type, id: idOf(el), label: labelOf(el) || clean(el.parentElement?.innerText, 120), on: el.checked, dis, name: el.name })
      if (type === 'submit' || type === 'button' || type === 'reset') return add({ k: 'button', id: idOf(el), text: clean(el.value || labelOf(el), 80), dis })
      if (type === 'file') return add({ k: 'file', id: idOf(el), label: labelOf(el), dis })
      if (type === 'image') return add({ k: 'shot', id: idOf(el), label: el.alt || 'image button', ...box })
      return add({ k: 'input', id: idOf(el), type, label: labelOf(el), value: type === 'password' ? '•'.repeat(String(el.value).length) : String(el.value ?? '').slice(0, 500), ph: clean(el.placeholder, 80), dis, ro: el.readOnly, req: el.required })
    }
    if (tag === 'TEXTAREA') return add({ k: 'textarea', id: idOf(el), label: labelOf(el), value: String(el.value).slice(0, 3000), dis, ro: el.readOnly })
    if (tag === 'SELECT') return add({ k: 'select', id: idOf(el), label: labelOf(el), dis, value: el.value, multi: el.multiple,
      options: [...el.options].slice(0, 400).map(o => [o.value, clean(o.text, 80), o.selected, o.disabled]) })
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO') {
      if (r.width >= 40 && r.height >= 18) add({ k: 'shot', id: idOf(el), label: clean(el.alt || el.title, 80), click: clickable(el, s) || !!el.closest('a,button'), ...box })
      return
    }
    if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
      if (r.width >= 40 && r.height >= 30) add({ k: 'shot', id: idOf(el), label: clean(el.title, 80), frame: true, click: true, ...box })
      return
    }
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return add({ k: 'textarea', id: idOf(el), label: clean(el.getAttribute('aria-label'), 120), value: clean(el.innerText, 3000), rich: true })

    if (clickable(el, s)) {
      const role = el.getAttribute('role')
      if (role === 'checkbox' || role === 'switch' || role === 'radio') return add({ k: role === 'radio' ? 'radio' : 'checkbox', id: idOf(el), label: clean(el.innerText || el.getAttribute('aria-label'), 120), on: el.getAttribute('aria-checked') === 'true', dis })
      const text = clean(el.innerText || el.getAttribute('aria-label') || el.title || el.querySelector('img')?.alt, 120)
      // a clickable card with fields inside: its insides matter more
      if (el.querySelector('input,select,textarea') || text.length > 119) { for (const c of el.childNodes) c.nodeType === 1 ? walk(c) : text0(c, el); return }
      if (!text && el.querySelector('img,svg,canvas')) return add({ k: 'shot', id: idOf(el), label: el.getAttribute('aria-label') || '', click: true, ...box })
      return add({ k: tag === 'A' && role !== 'button' ? 'link' : 'button', id: idOf(el), text: text || '•', dis,
        sel: el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') != null, opt: role === 'option' })
    }
    // a label shown with its field: only the fields inside it, not its words again
    if (tag === 'LABEL' && used.has(el)) { for (const c of el.children) walk(c); return }
    for (const c of el.childNodes) c.nodeType === 1 ? walk(c) : text0(c, el)
  }
  function text0(node, parent) {
    if (node.nodeType !== 3) return
    const t = clean(node.textContent)
    if (!t) return
    const h = parent.closest('h1,h2,h3,h4,h5,h6,th,legend')
    const last = out[out.length - 1]
    // words of one sentence (bold, links of text …) join up within their block
    let bp = parent
    while (bp.parentElement && getComputedStyle(bp).display.startsWith('inline')) bp = bp.parentElement
    if (last && last.k === 't' && last.p === bp && !!last.h === !!h) { last.text = clean(last.text + ' ' + t, 600); return }
    const err = /error|invalid|danger|alert/i.test(parent.className || '') || parent.getAttribute('role') === 'alert'
    add({ k: 't', text: t, h: h ? Number(h.tagName[1]) || 4 : 0, err, p: bp })
  }
  walk(document.body)

  const blocks = out.slice(0, 900).map(({ p, ...b }) => b)
  const focus = document.activeElement && M.ids.get(document.activeElement)
  return { blocks, focus: focus || null, vw, vh, sx: scrollX, sy: scrollY, height: Math.round(document.documentElement.scrollHeight) }
}

/** The tab, read for the phone. Pictures within sight come as small JPEG cut-outs. */
export async function mirrorOf(page, cache = new Map(), force = false) {
  const m = await page.evaluate(readPage)
  m.blocks = m.blocks.slice(0, MAX_BLOCKS)
  const cdp = page.__adalCdp ||= await page.target().createCDPSession()
  let shots = 0
  for (const b of m.blocks) {
    if (b.k !== 'shot') continue
    const { x, y, w, h, v } = b
    delete b.x; delete b.y; delete b.v
    b.ar = +(w / h).toFixed(3)
    if (!v || shots >= 8) { b.off = true; continue }
    const key = `${b.id}:${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}`
    const hit = cache.get(b.id)
    if (hit && hit.key === key && !force && Date.now() - hit.at < (b.frame ? 2500 : 15000)) { b.img = hit.img; shots++; continue }
    try {
      const scale = Math.min(1, 480 / w, 360 / h) * 1.5
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: x + (m.sx || 0), y: y + (m.sy || 0), width: w, height: h, scale: Math.min(1.5, scale) }, captureBeyondViewport: false })
      b.img = shot.data
      cache.set(b.id, { key, img: b.img, at: Date.now() })
      shots++
    } catch { b.off = true }
  }
  for (const b of m.blocks) if (b.k === 'shot') { delete b.w; delete b.h }
  m.url = page.url()
  m.title = await page.title().catch(() => '')
  return m
}

const handleOf = async (page, id) => {
  const h = await page.evaluateHandle((i) => window.__adalM?.els.get(Number(i)) || null, id)
  const el = h.asElement()
  if (!el) throw Object.assign(new Error('That part of the page is gone — it changed.'), { status: 409 })
  return el
}

/** One action from the phone on an element of the mirror. */
export async function mirrorInput(page, b = {}) {
  const el = await handleOf(page, b.id)
  if (b.kind === 'tap') {
    await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }))
    await el.click({ delay: 30 }).catch(async () => el.evaluate(e => e.click()))
  } else if (b.kind === 'tapAt') {
    await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }))
    const box = await el.boundingBox()
    if (!box) throw Object.assign(new Error('Not on the screen'), { status: 409 })
    const fx = Math.max(0, Math.min(1, Number(b.fx) || 0.5)), fy = Math.max(0, Math.min(1, Number(b.fy) || 0.5))
    await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height, { delay: 30 })
  } else if (b.kind === 'reveal') {
    await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }))
  } else if (b.kind === 'set') {
    // As a person: focus, clear, type the value with real keys, leave the field.
    const value = String(b.value ?? '').slice(0, 3000)
    await el.evaluate(e => e.scrollIntoView({ block: 'center' }))
    await el.focus()
    await el.evaluate((e) => {
      if (e.isContentEditable) { document.getSelection().selectAllChildren(e); return }
      if (typeof e.select === 'function') e.select()
    })
    await page.keyboard.press('Backspace')
    if (value) await page.keyboard.type(value, { delay: value.length > 60 ? 0 : 8 })
    await el.evaluate((e) => { e.dispatchEvent(new Event('change', { bubbles: true })) })
    if (b.enter) await page.keyboard.press('Enter')
    else await el.evaluate((e) => e.blur && e.blur())
  } else if (b.kind === 'pick') {
    const values = Array.isArray(b.value) ? b.value.map(String) : [String(b.value ?? '')]
    await el.select(...values)
  } else throw Object.assign(new Error('Unknown input'), { status: 400 })
}
