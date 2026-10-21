import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from './shared/Button'
import { useProfileFilters, ageOf } from './profileFilters'

/**
 * A broker's profiles with search, filters and sort. Everything runs on the
 * rows already loaded (a broker has tens of profiles), so it answers at once.
 */
export default function BrokerProfileList({ profiles, onUnassign }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  // Search first, then the filters and sort on what it found.
  const found = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return profiles
    return profiles.filter(p => [p.full_name, p.passport_number, p.labor_id, p.phone_number, p.national_id]
      .some(v => String(v || '').toLowerCase().includes(term)))
  }, [profiles, q])
  const { rows, filterBar, sortBar, active: filtering, clear } = useProfileFilters(found)
  const active = q.trim() || filtering

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
          {sortBar}
        </div>

        {filterBar}

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{rows.length} of {profiles.length} profiles</span>
          {active && (
            <button type="button" className="text-teal-700 dark:text-teal-300 hover:underline"
              onClick={() => { setQ(''); clear() }}>
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
