import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'

/**
 * Filters and sort for a list of profiles (Profiles page, broker page):
 * date range, experience, age, married, country, skill, religion (each with
 * "Unfilled", to find what still needs filling), browser run, and sort
 * by last updated / date added / name / age either way. Runs on the rows
 * already loaded, so it answers at once.
 */
const DAY = 86400000
const DATE_RANGES = [
  ['', 'All time'], ['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'],
  ['182', 'Last 6 months'], ['365', 'Last year'],
]
const AGES = [['', 'Any age'], ['18-24', '18 – 24'], ['25-29', '25 – 29'], ['30-34', '30 – 34'], ['35-39', '35 – 39'], ['40-200', '40 and over']]
const SORTS = [['updated_at', 'Last Updated'], ['created_at', 'Date Added'], ['full_name', 'Name'], ['age', 'Age']]

export function ageOf(dob) {
  const d = new Date(dob)
  if (!dob || isNaN(d)) return null
  const now = new Date()
  let a = now.getFullYear() - d.getFullYear()
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) a--
  return a >= 0 && a < 120 ? a : null
}

function skillsOf(raw) {
  if (!raw) return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(v)) return v.map(String)
    if (v && typeof v === 'object') return Object.keys(v).filter(k => v[k])
  } catch {}
  return String(raw).split(/[,;]/).map(s => s.trim()).filter(Boolean)
}

const label = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const norm = (s) => String(s || '').trim()
const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase()

function distinct(rows, pick) {
  const seen = new Map()
  for (const r of rows) for (const v of [].concat(pick(r))) {
    const k = norm(v).toLowerCase()
    if (k && !seen.has(k)) seen.set(k, norm(v))
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export function Select({ title, value, onChange, options }) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full rounded-lg border px-3 py-2 text-sm bg-slate-50 dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500/40 ${
          value ? 'border-teal-400 text-slate-900 dark:text-white' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
        }`}
      >
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  )
}

const EMPTY = { range: '', experience: '', age: '', married: '', country: '', skill: '', religion: '', run: '', stage: '' }
// "Unfilled": the field is empty on the profile.
const NONE = '__none__'
const RUNS = [['', 'Any'], ['running', 'Running now'], ['waiting', 'Waiting for you'], ['idle', 'Not running']]
const empty = (v) => !norm(v)
const match = (want, value) => (want === NONE ? empty(value) : same(value, want))

/** Which profiles have a Musaned / police run working or waiting (refreshed every 10 s). */
function useRunStates() {
  const [states, setStates] = useState({})
  useEffect(() => {
    let alive = true
    const load = () => api.get('/automations/active')
      .then(r => { if (alive) setStates(Object.fromEntries((r.data || []).map(x => [x.profile_id, x.state]))) })
      .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return states
}

/**
 * Where every profile stands (Musaned → employer → Wafid → LMIS contract →
 * visa), refreshed every 30 s. { names: [[key, label]…], of: {profileId: key} }
 */
function useStages() {
  const [st, setSt] = useState({ names: [], of: {} })
  useEffect(() => {
    let alive = true
    const load = () => api.get('/automations/stages')
      .then(r => { if (alive) setSt({ names: r.data?.stages || [], of: Object.fromEntries((r.data?.profiles || []).map(x => [x.profile_id, x.stage])) }) })
      .catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return st
}

export function useProfileFilters(profiles) {
  const [f, setF] = useState(EMPTY)
  const [sort, setSort] = useState('updated_at')
  const [dir, setDir] = useState('desc')
  const set = (k) => (v) => setF(prev => ({ ...prev, [k]: v }))
  const runStates = useRunStates()
  const stages = useStages()

  // The choices come from the profiles themselves.
  const choices = useMemo(() => ({
    experience: distinct(profiles, p => p.work_experience),
    married: distinct(profiles, p => p.marital_status),
    country: distinct(profiles, p => p.destination_country),
    skill: distinct(profiles, p => skillsOf(p.skills)),
    religion: distinct(profiles, p => p.religion),
  }), [profiles])

  const rows = useMemo(() => {
    const now = Date.now()
    const out = profiles.filter(p => {
      if (f.range) {
        const t = new Date(p.updated_at || p.created_at).getTime()
        if (!(t >= now - Number(f.range) * DAY)) return false
      }
      if (f.experience && !same(p.work_experience, f.experience)) return false
      if (f.age) {
        const [lo, hi] = f.age.split('-').map(Number)
        const a = ageOf(p.date_of_birth)
        if (a === null || a < lo || a > hi) return false
      }
      if (f.married && !match(f.married, p.marital_status)) return false
      if (f.country && !match(f.country, p.destination_country)) return false
      if (f.skill && (f.skill === NONE ? skillsOf(p.skills).length > 0 : !skillsOf(p.skills).some(s => same(s, f.skill)))) return false
      if (f.religion && !match(f.religion, p.religion)) return false
      if (f.run && (runStates[p.id] || 'idle') !== f.run) return false
      if (f.stage && (stages.of[p.id] || 'new') !== f.stage) return false
      return true
    })
    const key = (p) => sort === 'age' ? (ageOf(p.date_of_birth) ?? -1)
      : sort === 'full_name' ? norm(p.full_name).toLowerCase()
      : new Date(p[sort] || 0).getTime()
    out.sort((a, b) => {
      const x = key(a), y = key(b)
      const c = x < y ? -1 : x > y ? 1 : 0
      return dir === 'asc' ? c : -c
    })
    return out
  }, [profiles, f, sort, dir, runStates, stages])

  const opts = (any, list) => [['', any], ...list.map(v => [v, label(v)])]
  const withNone = (any, list) => [['', any], [NONE, 'Unfilled'], ...list.map(v => [v, label(v)])]

  const sortBar = (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-slate-500 whitespace-nowrap">Sort by:</span>
      <select value={sort} onChange={e => setSort(e.target.value)}
        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-sm">
        {SORTS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
      {[['asc', '↑', 'Oldest / A–Z / youngest first'], ['desc', '↓', 'Newest / Z–A / oldest first']].map(([d, arrow, tip]) => (
        <button key={d} type="button" title={tip} onClick={() => setDir(d)}
          className={`h-8 w-8 rounded-md text-lg font-bold ${dir === d ? 'text-teal-600 bg-teal-50 dark:bg-teal-900/30' : 'text-slate-400 hover:text-slate-600'}`}>
          {arrow}
        </button>
      ))}
    </div>
  )

  const filterBar = (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-9">
      <Select title="Date Range" value={f.range} onChange={set('range')} options={DATE_RANGES} />
      <Select title="Experience" value={f.experience} onChange={set('experience')} options={opts('Any', choices.experience)} />
      <Select title="Age" value={f.age} onChange={set('age')} options={AGES} />
      <Select title="Married" value={f.married} onChange={set('married')} options={withNone('Any', choices.married)} />
      <Select title="Country" value={f.country} onChange={set('country')} options={withNone('Any', choices.country)} />
      <Select title="Skill" value={f.skill} onChange={set('skill')} options={withNone('Any', choices.skill)} />
      <Select title="Religion" value={f.religion} onChange={set('religion')} options={withNone('Any', choices.religion)} />
      <Select title="Run" value={f.run} onChange={set('run')} options={RUNS} />
      <Select title="Stage" value={f.stage} onChange={set('stage')} options={[['', 'Any stage'], ...stages.names.map(([k, t]) => {
        const n = profiles.filter(p => (stages.of[p.id] || 'new') === k).length
        return [k, `${t} (${n})`]
      })]} />
    </div>
  )

  return { rows, filterBar, sortBar, active: Object.values(f).some(Boolean), clear: () => setF(EMPTY) }
}
