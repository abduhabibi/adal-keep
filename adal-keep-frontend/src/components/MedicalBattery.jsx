import { useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

/**
 * The medical's battery: how much of her Wafid medical (slip) time is left.
 * It drains day by day; warnings come at 2 months, 1 month, 2 weeks, 1 week,
 * 3 days and 1 day left (services/medicalValidity.js). Click to set the date.
 */
const DAY = 86400000
const nice = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export default function MedicalBattery({ profile, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [till, setTill] = useState(profile.medical_valid_until || '')
  const until = profile.medical_valid_until
  const from = profile.medical_valid_from

  const save = async () => {
    try {
      await api.put(`/profiles/${profile.id}`, { medical_valid_until: till || null })
      onSaved?.({ medical_valid_until: till || null })
      setEditing(false)
    } catch { toast.error('Could not save the date') }
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-slate-500">Medical valid till</span>
        <input type="date" value={till} onChange={e => setTill(e.target.value)} autoFocus
          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-xs" />
        <button type="button" onClick={save} className="px-2 py-0.5 rounded-md bg-teal-600 text-white font-semibold">Save</button>
        <button type="button" onClick={() => setEditing(false)} className="px-1 text-slate-400">✕</button>
      </span>
    )
  }
  if (!until) {
    return (
      <button type="button" onClick={() => setEditing(true)} title="When her Wafid medical (slip) runs out"
        className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600">
        <BatteryShape pct={0} color="bg-slate-300" /> medical validity — run Appointment slip or set it
      </button>
    )
  }

  const end = new Date(until + 'T23:59:59')
  const left = Math.max(0, Math.ceil((end - Date.now()) / DAY))
  // The full battery is the slip's whole time (or 90 days when the start is unknown).
  const total = from ? Math.max(1, Math.round((end - new Date(from + 'T00:00:00')) / DAY)) : 90
  const pct = Math.max(0, Math.min(100, Math.round(100 * left / total)))
  const color = left === 0 ? 'bg-red-600' : left <= 7 ? 'bg-red-500' : left <= 14 ? 'bg-amber-500' : pct <= 50 ? 'bg-lime-500' : 'bg-emerald-500'
  const text = left === 0 ? 'medical ran out' : left === 1 ? '1 day left' : left < 60 ? `${left} days left` : `${Math.floor(left / 30)} months left`

  return (
    <button type="button" onClick={() => setEditing(true)} title={`Medical valid ${from ? `${nice(from)} → ` : 'till '}${nice(until)} · click to change`}
      className={`inline-flex items-center gap-2 text-xs font-semibold ${left <= 7 ? 'text-red-600 dark:text-red-400' : left <= 14 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}`}>
      <BatteryShape pct={pct} color={color} blink={left <= 3} />
      <span>{text}</span>
      <span className="font-normal text-slate-400">· till {nice(until)}</span>
    </button>
  )
}

function BatteryShape({ pct, color, blink = false }) {
  return (
    <span className="inline-flex items-center">
      <span className="relative w-16 h-6 rounded-md border-2 border-slate-400 dark:border-slate-500 p-[2px] bg-white dark:bg-slate-900">
        <span className={`block h-full rounded-sm transition-all duration-700 ${color} ${blink ? 'animate-pulse' : ''}`} style={{ width: `${Math.max(pct, pct > 0 ? 6 : 0)}%` }} />
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-slate-700 dark:text-slate-200 mix-blend-normal">{pct}%</span>
      </span>
      <span className="w-1 h-2.5 rounded-r-sm bg-slate-400 dark:bg-slate-500" />
    </span>
  )
}
