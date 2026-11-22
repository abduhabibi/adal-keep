import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'

// The office cards (backend services/officeHealth.js): the morning backup line
// and, from 17:00, the day's summary. English, few words, in the glass style.

/** Says "this person is signed in on this PC" every minute (the office health page names each PC by it). */
export function PresencePing() {
  const { activeEmployee, user } = useAuth()
  const name = activeEmployee?.name || user?.name || ''
  useEffect(() => {
    if (!name) return
    const say = () => { if (!document.hidden) api.post('/office/presence', { name }).catch(() => {}) }
    say()
    const t = setInterval(say, 60000)
    return () => clearInterval(t)
  }, [name])
  return null
}

const KEY = 'ak-office-proof'
const last = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

/** Each morning (before noon) always; later only when something is wrong. Opens the office health page. */
export function BackupLine() {
  const [p, setP] = useState(() => last(KEY))
  useEffect(() => {
    let live = true
    api.get('/office/health').then(({ data }) => { if (live && data?.proof) { setP(data.proof); keep(KEY, data.proof) } }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!p || (new Date().getHours() >= 12 && p.level === 'ok')) return null
  const warn = p.level === 'warn'
  return (
    <Link to="/office" className="ak-glass-card flex min-w-0 items-center gap-3" translate="no">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${warn ? 'bg-red-500' : p.level === 'notice' ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
      <span className="min-w-0 text-[14px]">
        <span className="block font-semibold">{p.text}</span>
        {p.behind?.map(b => <span key={b} className="block ak-muted">{b}</span>)}
      </span>
    </Link>
  )
}

const DAY_KEY = 'ak-office-day'
/** From 17:00: "Today: 12 profiles added, 5 moved to EPRO, 2 waiting on you". */
export function DaySummaryCard() {
  const [d, setD] = useState(() => last(DAY_KEY))
  useEffect(() => {
    let live = true
    const load = () => api.get('/office/day').then(({ data }) => { if (live && data) { setD(data); keep(DAY_KEY, data) } }).catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 5 * 60000)
    return () => { live = false; clearInterval(t) }
  }, [])
  const today = new Date().toLocaleDateString('en-CA')
  if (!d || d.day !== today || new Date().getHours() < 17) return null
  return (
    <section className="ak-glass-card" translate="no">
      <p className="ak-eyebrow">End of day</p>
      <p className="text-[16px] font-semibold">{d.text}</p>
    </section>
  )
}
