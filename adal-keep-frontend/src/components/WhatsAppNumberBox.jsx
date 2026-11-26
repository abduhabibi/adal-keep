/**
 * The WhatsApp number box (the owner, 2026-11-26): "+251" fixed in front, the person types
 * the 9 digits and it goes on by itself when they are there (Enter too). A paste of 09…,
 * 2519… or +251 9… becomes the same. Another country behind a small link.
 * onChange(full digits) · onDone(full digits). Off (off prop) or broken: a plain box.
 */
import { Component, useRef, useState } from 'react'
import { COUNTRY, localPart, isLocal, phoneDigits } from '../lib/waNumber'

const BOX = 'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg dark:border-slate-600 dark:bg-slate-800'

function Box({ value, onChange, onDone, disabled, autoFocus, className = '' }) {
  const start = String(value || '').replace(/\D/g, '')
  const [other, setOther] = useState(!!start && !start.startsWith(COUNTRY) && !isLocal(localPart(start)))
  const [local, setLocal] = useState(localPart(start))
  const [free, setFree] = useState(start ? `+${start}` : '+')
  const fired = useRef('')
  const set = (v) => {
    const l = localPart(v)
    setLocal(l)
    onChange?.(l ? COUNTRY + l : '')
    // The 9 digits are there: on by itself, once for this number.
    if (isLocal(l) && fired.current !== l && !disabled) { fired.current = l; onDone?.(COUNTRY + l) }
    if (!isLocal(l)) fired.current = ''
  }
  if (other) {
    const d = phoneDigits(free)
    return (
      <div className={className}>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (d.length >= 9) onDone?.(d) }}>
          <input className={BOX} inputMode="tel" autoComplete="tel" value={free} disabled={disabled} aria-label="WhatsApp number with its country code"
            onChange={e => { setFree(e.target.value); onChange?.(phoneDigits(e.target.value)) }} />
          <button type="submit" disabled={disabled || d.length < 9} className="rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40">Go</button>
        </form>
        <button type="button" className="mt-1 text-xs text-slate-500 underline" onClick={() => { setOther(false); set(free) }}>Ethiopian number (+251)</button>
      </div>
    )
  }
  return (
    <div className={className}>
      <form onSubmit={e => { e.preventDefault(); if (isLocal(local)) { fired.current = local; onDone?.(COUNTRY + local) } }}
        className="flex items-stretch overflow-hidden rounded-xl border border-slate-300 bg-white focus-within:border-emerald-500 dark:border-slate-600 dark:bg-slate-800">
        <span className="flex items-center border-r border-slate-200 bg-slate-50 px-3 text-lg font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" translate="no">+251</span>
        <input className="min-w-0 flex-1 bg-transparent px-3 py-3 text-lg tracking-wider outline-none" inputMode="numeric" autoComplete="tel-national" autoFocus={autoFocus}
          aria-label="WhatsApp number after +251" placeholder="9XX XXX XXX" value={local} disabled={disabled}
          onChange={e => set(e.target.value)}
          onPaste={e => { e.preventDefault(); set(e.clipboardData.getData('text')) }} />
      </form>
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>{local && !isLocal(local) ? `${9 - local.length} more digit${9 - local.length === 1 ? '' : 's'}` : 'Starts with 9 or 7'}</span>
        <button type="button" className="underline" onClick={() => setOther(true)}>other country</button>
      </div>
    </div>
  )
}

/** Anything wrong in it, or switched off: the plain box as before. */
export default class WhatsAppNumberBox extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[whatsapp number box]', e) }
  render() {
    const { value, onChange, onDone, disabled, off, className, placeholder } = this.props
    if (!off && !this.state.bad) return <Box {...this.props} />
    return (
      <form className={className} onSubmit={e => { e.preventDefault(); onDone?.(phoneDigits(value)) }}>
        <input className={BOX} inputMode="tel" autoComplete="tel" placeholder={placeholder || '0911… or +251 9…'} value={value || ''} disabled={disabled}
          onChange={e => onChange?.(e.target.value)} />
      </form>
    )
  }
}
