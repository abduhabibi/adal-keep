/**
 * Her broker, typed: the matches show at once (lib/brokerSearch.js, from the brokers already
 * here). A click or Enter picks, the arrows move. Not found: it says so; a broker is never made here.
 */
import { Component, useEffect, useId, useMemo, useRef, useState } from 'react'
import { searchBrokers, brokerName, brokerPhone, brokerKey } from '../lib/brokerSearch'

function Search({ brokers, value, onChange, className = '' }) {
  const picked = (brokers || []).find(b => String(b.id) === String(value))
  const [text, setText] = useState(picked ? brokerName(picked) : '')
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const id = useId(), list = useRef(null)
  useEffect(() => { if (picked) setText(brokerName(picked)) }, [picked?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const found = useMemo(() => (open ? searchBrokers(brokers, picked && text === brokerName(picked) ? '' : text) : []), [open, brokers, text, picked])
  useEffect(() => { list.current?.children[at]?.scrollIntoView?.({ block: 'nearest' }) }, [at, open])
  const pick = (b) => { onChange(String(b.id)); setText(brokerName(b)); setOpen(false) }
  const type = (v) => { setText(v); setAt(0); setOpen(true); if (value) onChange('') }   // other words: no longer the one picked
  const key = (e) => {
    const r = brokerKey(e.key, { at, open, found })
    if (!r) return
    if (r.stop) { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.() }
    if (r.pick) return pick(r.pick)
    setOpen(r.open); setAt(r.at)
  }
  return (
    <div>
      <input className={className} type="text" autoComplete="off" spellCheck={false} placeholder={brokers?.length ? 'Type the broker\'s name' : 'Loading brokers…'} value={text} translate="no"
        role="combobox" aria-expanded={open} aria-controls={`${id}-l`} aria-autocomplete="list" aria-activedescendant={open && found.length ? `${id}-${at}` : undefined}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)} onChange={e => type(e.target.value)} onKeyDown={key} />
      {open && found.length > 0 && (
        <ul ref={list} id={`${id}-l`} role="listbox" translate="no" onMouseDown={e => e.preventDefault()} className="mt-1 overflow-y-auto rounded-xl border border-slate-300 bg-white text-sm font-normal text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" style={{ maxHeight: 'min(13rem, 30vh)' }}>
          {found.map((b, i) => (
            <li key={b.id} id={`${id}-${i}`} role="option" aria-selected={i === at}
              onMouseDown={e => { e.preventDefault(); pick(b) }} onMouseEnter={() => setAt(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ${i === at ? 'bg-teal-600 text-white' : ''}`}>
              <span className="min-w-0 truncate">{brokerName(b)}</span>
              {brokerPhone(b) && <span className="shrink-0 text-xs opacity-75">{brokerPhone(b)}</span>}
            </li>
          ))}
        </ul>
      )}
      {text.trim() && !value && !open && <span className="mt-1 block text-xs font-normal text-amber-700 dark:text-amber-300">Pick the broker from the list</span>}
      {open && !found.length && text.trim() && <span className="mt-1 block text-xs font-normal text-amber-700 dark:text-amber-300">Not found. A new broker is added on the Brokers page.</span>}
    </div>
  )
}

/** Anything wrong in it, or switched off: the plain list as before. */
export default class BrokerSearch extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[broker search]', e) }
  render() {
    const { brokers, value, onChange, className, off } = this.props
    if (!off && !this.state.bad) return <Search {...this.props} />
    return (
      <select className={className} value={value ?? ''} onChange={e => onChange(e.target.value)}>
        <option value="">— Choose —</option>
        {(brokers || []).map(b => <option key={b.id} value={b.id}>{brokerName(b)}</option>)}
      </select>
    )
  }
}
