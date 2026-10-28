/**
 * The journey as one start that forks in two:
 *
 *   CV → Musaned → Wafid ─┬─ 🏛 LMIS     LMIS contract
 *                          └─ 🇸🇦 Embassy Tasheer → Insurance → Enjaz · Visa
 *
 * <JourneyFork> draws it. On a profile each step shows its state; on the
 * profile list each step shows how many profiles finished it, and a click
 * picks it as a filter (lit green), a second click lets it go.
 */
import { useEffect, useRef, useState } from 'react'
import api from '../services/api'

export const SHARED = [['cv', 'CV'], ['musaned', 'Musaned'], ['wafid', 'Wafid']]
export const BRANCHES = [
  { key: 'lmis-track', title: 'LMIS', icon: '🏛', steps: [['lmis', 'LMIS contract', 'Contract']] },
  { key: 'embassy-track', title: 'Embassy', icon: '🇸🇦', steps: [['tasheer', 'Tasheer'], ['insurance', 'Insurance'], ['visa', 'Enjaz · Visa', 'Visa']] },
]

const LOOK = {
  done:   { dot: 'bg-emerald-500 text-white', text: 'text-emerald-700 dark:text-emerald-300', line: 'bg-emerald-400' },
  active: { dot: 'bg-amber-400 text-white animate-pulse', text: 'text-amber-700 dark:text-amber-300', line: 'bg-slate-200 dark:bg-slate-700' },
  failed: { dot: 'bg-red-500 text-white', text: 'text-red-600 dark:text-red-400', line: 'bg-slate-200 dark:bg-slate-700' },
  todo:   { dot: 'bg-slate-100 ring-1 ring-slate-300 text-slate-500 dark:bg-slate-800 dark:ring-slate-600 dark:text-slate-300', text: 'text-slate-500', line: 'bg-slate-200 dark:bg-slate-700' },
  soon:   { dot: 'bg-white dark:bg-slate-900 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-400', text: 'text-slate-400', line: 'bg-slate-200 dark:bg-slate-700' },
}
const ICON = { done: '✓', active: '•', failed: '!' }

// Where each step sits: x as a share of the width, row 0 = LMIS (top),
// 1 = the shared start (middle), 2 = Embassy (bottom).
const SPOT = {
  cv: [0, 1], musaned: [0.17, 1], wafid: [0.34, 1],
  lmis: [0.62, 0],
  tasheer: [0.62, 2], insurance: [0.81, 2], visa: [1, 2],
}
const EDGE = 30   // px kept at the left for the first step's name
const LABELS = 78 // px kept at the right for the branches' names
// Each step's step before it (the wires), and how each wire is drawn.
const PARENT = { musaned: 'cv', wafid: 'musaned', lmis: 'wafid', tasheer: 'wafid', insurance: 'tasheer', visa: 'insurance' }
const WIRES = Object.entries(PARENT).map(([to, from]) => ({ from, to, curve: from === 'wafid' }))
const SIZE = {
  compact: { r: 11, rowGap: 26, block: 36 },
  full:    { r: 14, rowGap: 42, block: 60 },
}

function Node({ k, title, n, state, note, count, selected, dim, onSelect, compact, narrow, left, top }) {
  const pick = !!onSelect
  const l = pick ? (selected ? LOOK.done : LOOK.todo) : (LOOK[state] || LOOK.todo)
  return (
    <button type="button" title={note || title}
      onClick={() => onSelect?.(k)}
      className={`absolute z-10 -translate-x-1/2 flex flex-col items-center text-center transition-all duration-300 ${dim ? 'opacity-40 hover:opacity-80' : ''} ${pick || state ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ left, top }}>
      <span className={`${compact ? 'w-[22px] h-[22px] text-[10px]' : 'w-7 h-7 text-[11px]'} rounded-full flex items-center justify-center font-bold transition-all duration-300 ${l.dot} ${selected ? 'ring-4 ring-emerald-300/70 shadow-[0_0_16px_rgba(16,185,129,.8)] scale-110' : ''}`}>
        {pick ? (count ?? 0) : (ICON[state] || n)}
      </span>
      <span className={`${narrow ? 'mt-0.5 text-[9px] tracking-tight' : compact ? 'mt-0.5 text-[10px]' : 'mt-1 text-[11px]'} whitespace-nowrap font-semibold leading-tight ${l.text}`}>{title}</span>
      {note && <span className="text-[10px] text-slate-400 leading-tight whitespace-nowrap max-w-[96px] truncate">{note}</span>}
    </button>
  )
}

/**
 * states: { stepKey: 'done' | 'active' | 'failed' | 'todo' | 'soon' }, notes: { stepKey: text }
 * — or, on the list — counts: { stepKey: n }, selected, onSelect(stepKey).
 * The steps are joined by wires; from Wafid two curved wires fork to LMIS
 * (up) and the Embassy (down). Lit wires glow green with a pulse running along.
 */
export function JourneyFork({ states = {}, notes = {}, counts, selected, onSelect, compact = false }) {
  const pick = !!onSelect
  const z = compact ? SIZE.compact : SIZE.full
  const ref = useRef(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const height = z.rowGap * 2 + z.block
  // Compact (the list's filter) fits any width — no sideways scrolling: on a
  // narrow screen the branches show only their icons.
  const narrow = compact && w > 0 && w < 520
  const edge = compact ? 22 : EDGE, labels = narrow ? 18 : LABELS
  const cx = (k) => edge + SPOT[k][0] * Math.max(0, w - edge - labels - edge)
  const cy = (k) => SPOT[k][1] * z.rowGap + z.r

  // The path to the picked step lights up (on the list); on a profile a wire
  // is lit when both its ends are done, and pulses towards a step in progress.
  const chain = new Set()
  for (let k = selected; k; k = PARENT[k]) chain.add(k)
  const lit = (wire) => pick ? chain.has(wire.to) : states[wire.from] === 'done' && ['done', 'active'].includes(states[wire.to])
  const pulse = (wire) => pick ? chain.has(wire.to) : states[wire.from] === 'done' && states[wire.to] === 'active'

  const path = ({ from, to, curve }) => {
    const x1 = cx(from) + z.r + 1, y1 = cy(from), x2 = cx(to) - z.r - 1, y2 = cy(to)
    if (!curve) return `M${x1},${y1} L${x2},${y2}`
    const d = (x2 - x1) * 0.55
    return `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`
  }
  const steps = [...SHARED, ...BRANCHES.flatMap(b => b.steps)]

  return (
    <div className={compact ? 'overflow-hidden' : 'overflow-x-auto overflow-y-hidden'}>
      <div ref={ref} className="relative" style={{ height, minWidth: compact ? 0 : 460 }}>
        {w > 0 && (
          <svg className="absolute inset-0 pointer-events-none" width={w} height={height} aria-hidden="true">
            {WIRES.map(wire => {
              const on = lit(wire)
              return (
                <g key={wire.to}>
                  <path d={path(wire)} fill="none" strokeLinecap="round"
                    className={`transition-all duration-500 ${on ? 'stroke-emerald-500 journey-glow' : 'stroke-slate-300 dark:stroke-slate-600'}`}
                    strokeWidth={on ? 2.5 : 2} />
                  {pulse(wire) && (
                    <path d={path(wire)} fill="none" strokeLinecap="round" pathLength="100"
                      className="stroke-emerald-100 journey-pulse" strokeWidth={3} />
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {w > 0 && steps.map(([k, title, short], i) => (
          <Node key={k} k={k} title={compact && short ? short : title} n={i + 1} state={states[k]} note={pick ? '' : notes[k]}
            count={counts?.[k]} selected={selected === k} dim={pick && selected && !chain.has(k)} onSelect={onSelect}
            compact={compact} narrow={narrow} left={cx(k)} top={SPOT[k][1] * z.rowGap} />
        ))}
        {/* the two branches' names, at the right end of their rows */}
        {BRANCHES.map((b, i) => (
          <span key={b.key} className="absolute right-0 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap text-right"
            style={{ top: (i === 0 ? 0 : 2) * z.rowGap + z.r - 7 }}>
            {b.icon}{!narrow && ` ${b.title}`}
          </span>
        ))}
      </div>
    </div>
  )
}

/** On a profile: her journey, refreshed every 15 s. */
export default function ProfileJourney({ profileId }) {
  const [j, setJ] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.get(`/profiles/${profileId}/journey`).then(r => alive && setJ(r.data)).catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [profileId])
  if (!j) return null
  const all = [...j.lmis, ...j.embassy]
  const states = Object.fromEntries(all.map(s => [s.key, s.state]))
  const notes = Object.fromEntries(all.map(s => [s.key, s.note]))
  return (
    <section data-tour="profile-journey" className="panel p-4" onClick={(e) => { if (e.target.closest('button')) document.getElementById('ai-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
      <JourneyFork states={states} notes={notes} />
    </section>
  )
}
