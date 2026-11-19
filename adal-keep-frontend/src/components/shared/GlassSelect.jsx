import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'

/**
 * A dropdown on frosted glass, open menu included (2026-11-19). A drop-in for
 * <select>: same value / onChange(event) API and the same <option> and
 * <optgroup> children, so `<select ...>` becomes `<GlassSelect ...>`.
 * onChange gets { target: { value, name, id }, currentTarget: same }.
 * Keyboard: Up/Down/Home/End move, Enter/Space picks, Esc closes, typing jumps.
 * `required` still stops a form from sending while it is empty.
 */

const textOf = (node) => {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf(node.props.children)
  return ''
}

function readOptions(children, group = null, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) { readOptions(child.props.children, group, out); return }
    if (child.type === 'optgroup') { readOptions(child.props.children, child.props.label, out); return }
    if (child.type === 'option') {
      const label = textOf(child.props.children)
      const value = child.props.value !== undefined ? String(child.props.value) : label
      out.push({ value, label, disabled: !!child.props.disabled, group })
    }
  })
  return out
}

export default function GlassSelect({
  value, defaultValue, onChange, children, className = '', disabled = false, required = false,
  id, name, title, placeholder, style, hideChevron = false, 'aria-label': ariaLabel, ...rest
}) {
  const options = useMemo(() => readOptions(children), [children])
  const [inner, setInner] = useState(defaultValue ?? options[0]?.value ?? '')
  const current = value !== undefined && value !== null ? String(value) : String(inner)
  const selected = options.find(o => o.value === current)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState(null)
  const btn = useRef(null)
  const list = useRef(null)
  const typed = useRef({ text: '', at: 0 })
  const listId = useId()

  const pick = useCallback((o) => {
    if (!o || o.disabled) return
    setOpen(false)
    btn.current?.focus()
    if (o.value === current) return
    if (value === undefined) setInner(o.value)
    const target = { value: o.value, name, id }
    onChange?.({ target, currentTarget: target, preventDefault() {}, stopPropagation() {} })
  }, [current, value, name, id, onChange])

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const up = below < 220 && above > below
    const maxH = Math.max(140, Math.min(320, up ? above : below))
    const width = Math.max(r.width, 160)
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8)
    setPos({ left, width, maxH, top: up ? undefined : r.bottom + 6, bottom: up ? window.innerHeight - r.top + 6 : undefined })
  }, [])

  const openMenu = () => {
    if (disabled) return
    place()
    const i = options.findIndex(o => o.value === current)
    setActive(i >= 0 ? i : options.findIndex(o => !o.disabled))
    setOpen(true)
  }

  useLayoutEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!btn.current?.contains(e.target) && !list.current?.contains(e.target)) setOpen(false) }
    const move = (e) => { if (!list.current?.contains(e.target)) place() }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', move, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', move, true)
    }
  }, [open, place])
  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const step = (from, dir) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i
    return from
  }

  const typeAhead = (key) => {
    const now = Date.now()
    const t = typed.current
    t.text = now - t.at > 700 ? key : t.text + key
    t.at = now
    const q = t.text.toLowerCase()
    const start = open ? active : options.findIndex(o => o.value === current)
    const order = [...options.keys()].map(k => (k + Math.max(0, start) + (t.text.length === 1 ? 1 : 0)) % options.length)
    const hit = order.find(i => !options[i].disabled && options[i].label.trim().toLowerCase().startsWith(q))
    if (hit === undefined) return
    if (open) setActive(hit)
    else pick(options[hit])
  }

  const onKeyDown = (e) => {
    if (disabled) return
    const k = e.key
    if (k === 'Escape' || k === 'Tab') { if (open) { if (k === 'Escape') e.preventDefault(); setOpen(false) } return }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      if (!open) { if (e.altKey || k === 'ArrowDown' || k === 'ArrowUp') openMenu(); return }
      setActive(a => step(a, k === 'ArrowDown' ? 1 : -1))
      return
    }
    if (k === 'Home' || k === 'End') {
      if (!open) return
      e.preventDefault()
      setActive(k === 'Home' ? step(-1, 1) : step(options.length, -1))
      return
    }
    if (k === 'Enter' || (k === ' ' && Date.now() - typed.current.at > 700)) {
      e.preventDefault()
      if (open) pick(options[active]); else openMenu()
      return
    }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAhead(k) }
  }

  const shown = selected ? selected.label : (placeholder || '')
  let lastGroup = null

  return (
    <>
      <button
        ref={btn} type="button" id={id} title={title} disabled={disabled}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel} aria-required={required || undefined}
        onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKeyDown}
        className={`ak-gsel-btn ${className}`} style={style} {...rest}
      >
        <span className={`ak-gsel-value${selected && selected.value !== '' ? '' : ' is-empty'}`}>{shown || ' '}</span>
        {!hideChevron && <Icon name="chevronDown" size={14} strokeWidth={2.2} className={`ak-gsel-chev${open ? ' is-open' : ''}`} />}
      </button>
      {required && (
        <input tabIndex={-1} aria-hidden="true" className="ak-gsel-req" required value={current} name={name}
          onChange={() => {}} onFocus={() => btn.current?.focus()} />
      )}
      {!required && name && <input type="hidden" name={name} value={current} />}
      {open && pos && createPortal(
        <ul
          ref={list} id={listId} role="listbox" aria-label={ariaLabel || title} tabIndex={-1}
          className="ak-gsel-menu"
          style={{ left: pos.left, minWidth: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          onMouseDown={e => e.preventDefault()}
        >
          {options.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null
            lastGroup = o.group
            return (
              <Fragment key={`${i}-${o.value}`}>
                {head && <li role="presentation" className="ak-gsel-group">{head}</li>}
                <li
                  id={`${listId}-${i}`} data-i={i} role="option" aria-selected={o.value === current} aria-disabled={o.disabled || undefined}
                  className={`ak-gsel-opt${i === active ? ' is-active' : ''}${o.value === current ? ' is-on' : ''}${o.disabled ? ' is-off' : ''}${o.group ? ' in-group' : ''}`}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => pick(o)}
                >
                  <span className="ak-gsel-opt-label">{o.label || '—'}</span>
                  {o.value === current && <Icon name="check" size={14} strokeWidth={2.2} />}
                </li>
              </Fragment>
            )
          })}
        </ul>,
        document.body,
      )}
    </>
  )
}
