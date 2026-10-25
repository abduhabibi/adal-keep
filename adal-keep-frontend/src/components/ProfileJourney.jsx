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
import { useEffect, useState } from 'react'
import api from '../services/api'

export const SHARED = [['cv', 'CV'], ['musaned', 'Musaned'], ['wafid', 'Wafid']]
export const BRANCHES = [
  { key: 'lmis-track', title: 'LMIS', steps: [['lmis', 'LMIS contract']] },
  { key: 'embassy-track', title: 'Embassy', steps: [['tasheer', 'Tasheer'], ['insurance', 'Insurance'], ['visa', 'Enjaz · Visa']] },
]

const LOOK = {
  done:   { dot: 'bg-emerald-500 text-white', text: 'text-emerald-700 dark:text-emerald-300', line: 'bg-emerald-400' },
  active: { dot: 'bg-amber-400 text-white animate-pulse', text: 'text-amber-700 dark:text-amber-300', line: 'bg-slate-200 dark:bg-slate-700' },
  failed: { dot: 'bg-red-500 text-white', text: 'text-red-600 dark:text-red-400', line: 'bg-slate-200 dark:bg-slate-700' },
  todo:   { dot: 'bg-slate-100 ring-1 ring-slate-300 text-slate-500 dark:bg-slate-800 dark:ring-slate-600 dark:text-slate-300', text: 'text-slate-500', line: 'bg-slate-200 dark:bg-slate-700' },
  soon:   { dot: 'bg-white dark:bg-slate-900 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-400', text: 'text-slate-400', line: 'bg-slate-200 dark:bg-slate-700' },
}
const ICON = { done: '✓', active: '•', failed: '!' }
const ROW = 58 // px: one row of steps (circle + title + note)
const ROW_COMPACT = 38 // px: the list's version (small circle + one-line title)

function Node({ k, title, n, state, note, count, selected, dim, onSelect, compact }) {
  const pick = !!onSelect
  const l = pick ? (selected ? LOOK.done : LOOK.todo) : (LOOK[state] || LOOK.todo)
  return (
    <button type="button" title={note || title}
      onClick={() => onSelect?.(k)}
      className={`relative z-10 flex flex-col items-center shrink-0 text-center transition-all duration-300 ${compact ? 'px-1' : 'w-[62px]'} ${dim ? 'opacity-40 hover:opacity-80' : ''} ${pick || state ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ height: compact ? ROW_COMPACT : ROW }}>
      <span className={`${compact ? 'w-[22px] h-[22px] text-[10px]' : 'w-7 h-7'} rounded-full flex items-center justify-center text-[11px] font-bold transition-all duration-300 ${l.dot} ${selected ? 'ring-4 ring-emerald-300/70 shadow-[0_0_14px_rgba(16,185,129,.7)] scale-110' : ''}`}>
        {pick ? (count ?? 0) : (ICON[state] || n)}
      </span>
      <span className={`${compact ? 'mt-0.5 text-[10px] whitespace-nowrap' : 'mt-1 text-[11px]'} font-semibold leading-tight ${l.text}`}>{title}</span>
      {note && <span className="text-[10px] text-slate-400 leading-tight truncate max-w-full">{note}</span>}
    </button>
  )
}

const Line = ({ on, compact }) => <span className={`h-0.5 shrink-0 self-start transition-colors ${compact ? 'w-2.5 mt-[10px]' : 'w-3 sm:w-5 mt-3.5'} duration-300 ${on ? LOOK.done.line : LOOK.todo.line}`} />

/**
 * states: { stepKey: 'done' | 'active' | 'failed' | 'todo' | 'soon' }, notes: { stepKey: text }
 * — or, on the list — counts: { stepKey: n }, selected, onSelect(stepKey).
 */
export function JourneyFork({ states = {}, notes = {}, counts, selected, onSelect, compact = false }) {
  const pick = !!onSelect
  const row = compact ? ROW_COMPACT : ROW
  const mid = compact ? 11 : 14 // the circles' middle
  const node = ([k, title], n) => (
    <Node key={k} k={k} title={title} n={n} state={states[k]} note={pick ? '' : notes[k]} count={counts?.[k]}
      selected={selected === k} dim={pick && selected && selected !== k} onSelect={onSelect} compact={compact} />
  )
  const lit = (k) => pick ? selected === k : states[k] === 'done'
  return (
    <div className="flex items-start overflow-x-auto pb-1 [scrollbar-width:thin]">
      {/* the shared start */}
      {SHARED.map((s, i) => (
        <div key={s[0]} className="flex items-start">
          {node(s, i + 1)}
          <Line on={lit(s[0])} compact={compact} />
        </div>
      ))}
      {/* the fork: a line down to the second branch */}
      <div className={`relative flex flex-col pl-3 sm:pl-4 ${compact ? 'gap-1' : 'gap-2'}`}>
        <span className={`absolute left-0 w-0.5 ${lit('wafid') ? LOOK.done.line : LOOK.todo.line}`} style={{ top: mid, height: row + (compact ? 4 : 8) + 1 }} />
        {BRANCHES.map(b => (
          <div key={b.key} className="relative flex items-start" style={{ height: row }}>
            <span className={`absolute -left-3 sm:-left-4 w-3 sm:w-4 h-0.5 ${lit('wafid') ? LOOK.done.line : LOOK.todo.line}`} style={{ top: mid }} />
            <span className={`self-start mr-1 text-[9px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap ${compact ? 'mt-[5px] w-[46px]' : 'mt-2 w-[52px]'}`}>{b.title}</span>
            {b.steps.map((s, i) => (
              <div key={s[0]} className="flex items-start">
                {i > 0 && <Line on={lit(b.steps[i - 1][0])} compact={compact} />}
                {node(s, SHARED.length + i + 1)}
              </div>
            ))}
          </div>
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
    <section className="panel p-4" onClick={(e) => { if (e.target.closest('button')) document.getElementById('ai-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
      <JourneyFork states={states} notes={notes} />
    </section>
  )
}
