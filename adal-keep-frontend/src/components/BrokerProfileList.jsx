import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from './shared/Button'

/**
 * A broker's profiles with search, filters and sort. Everything runs on the
 * rows already loaded (a broker has tens of profiles), so it answers at once.
 */
const DAY = 86400000
const DATE_RANGES = [
  ['', 'All time'], ['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'],
  ['182', 'Last 6 months'], ['365', 'Last year'],
]
const AGES = [['', 'Any age'], ['18-24', '18 – 24'], ['25-29', '25 – 29'], ['30-34', '30 – 34'], ['35-39', '35 – 39'], ['40-200', '40 and over']]
const SORTS = [['updated_at', 'Last Updated'], ['created_at', 'Date Added'], ['full_name', 'Name'], ['age', 'Age']]

function ageOf(dob) {
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

function Select({ title, value, onChange, options }) {
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

const EMPTY = { range: '', experience: '', age: '', married: '', country: '', skill: '', religion: '' }

export default function BrokerProfileList({ profiles, onUnassign }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [f, setF] = useState(EMPTY)
  const [sort, setSort] = useState('updated_at')
  const [dir, setDir] = useState('desc')
  const set = (k) => (v) => setF(prev => ({ ...prev, [k]: v }))

  // The choices come from this broker's own profiles.
  const choices = useMemo(() => ({
    experience: distinct(profiles, p => p.work_experience),
    married: distinct(profiles, p => p.marital_status),
    country: distinct(profiles, p => p.destination_country),
    skill: distinct(profiles, p => skillsOf(p.skills)),
    religion: distinct(profiles, p => p.religion),
  }), [profiles])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const now = Date.now()
    const out = profiles.filter(p => {
      if (term && ![p.full_name, p.passport_number, p.labor_id, p.phone_number, p.national_id]
        .some(v => String(v || '').toLowerCase().includes(term))) return false
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
      if (f.married && !same(p.marital_status, f.married)) return false
      if (f.country && !same(p.destination_country, f.country)) return false
      if (f.skill && !skillsOf(p.skills).some(s => same(s, f.skill))) return false
      if (f.religion && !same(p.religion, f.religion)) return false
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
  }, [profiles, q, f, sort, dir])

  const active = q.trim() || Object.values(f).some(Boolean)
  const opts = (any, list) => [['', any], ...list.map(v => [v, label(v)])]

  return (
    <div>
      <div className="p-5 space-y-4 border-b border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search name, passport, labor ID, phone…"
            className="flex-1 min-w-[220px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Sort by:</span>
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
        </div>

        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
          <Select title="Date Range" value={f.range} onChange={set('range')} options={DATE_RANGES} />
          <Select title="Experience" value={f.experience} onChange={set('experience')} options={opts('Any', choices.experience)} />
          <Select title="Age" value={f.age} onChange={set('age')} options={AGES} />
          <Select title="Married" value={f.married} onChange={set('married')} options={opts('Any', choices.married)} />
          <Select title="Country" value={f.country} onChange={set('country')} options={opts('Any', choices.country)} />
          <Select title="Skill" value={f.skill} onChange={set('skill')} options={opts('Any', choices.skill)} />
          <Select title="Religion" value={f.religion} onChange={set('religion')} options={opts('Any', choices.religion)} />
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{rows.length} of {profiles.length} profiles</span>
          {active && (
            <button type="button" className="text-teal-700 dark:text-teal-300 hover:underline"
              onClick={() => { setQ(''); setF(EMPTY) }}>
              Clear search and filters
            </button>
          )}
        </div>
      </div>

      {profiles.length === 0 ? (
        <div className="text-center py-14 text-slate-500">ምንም ፕሮፋይል የለም</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-14 text-slate-500">No profile matches this search.</div>
      ) : (
        <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 text-xs text-slate-500 uppercase bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="px-5 py-3 text-left">ስም</th>
                <th className="px-5 py-3 text-left">ስልክ</th>
                <th className="px-5 py-3 text-left">Age · Country</th>
                <th className="px-5 py-3 text-right">ተግባር</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const age = ageOf(p.date_of_birth)
                return (
                  <tr key={p.id} onClick={() => navigate(`/profiles/${p.id}`)}
                    className="cursor-pointer border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-5 py-3">
                      <div className="font-medium">{p.full_name}</div>
                      <div className="text-xs text-slate-500">{[p.passport_number, p.labor_id].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{p.phone_number || '—'}</td>
                    <td className="px-5 py-3 text-slate-500">{[age !== null && `${age} yrs`, p.destination_country].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/profiles/${p.id}`) }}>
                          ይመልከቱ
                        </Button>
                        <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={(e) => { e.stopPropagation(); onUnassign(p.id) }}>
                          አስወግድ
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
