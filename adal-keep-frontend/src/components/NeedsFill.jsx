/**
 * What a step still needs, filled right here (asked on 2026-11-20): the robot
 * is asked first (GET …/needs: its start's own checks, nothing starts), each missing thing
 * shows as its box — a choice, a text, a number, a date, or the document's own
 * card to upload into — and once nothing is missing the step goes on by
 * itself (onReady). For the CV: the CV page's own list (cv/profile-readiness).
 */
import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'
import FieldCard from './fields/FieldCard'
import { missingNow } from '../lib/missingNow'
import { onDataChange } from '../lib/changes'

const COUNTRIES = ['Kuwait', 'Saudi Arabia', 'Jordan', 'UAE', 'Qatar', 'Bahrain', 'Oman', 'Lebanon']
// A missing thing's name (as the robots say it) → what to show for it.
const KNOWN = [
  [/personal photo|^photo( missing)?$/i, { file: 'Photo' }],
  [/full ?body/i, { file: 'Full Body Photo' }],
  [/^passport( missing)?$/i, { file: 'Passport' }],
  [/^slip( missing)?$/i, { file: 'Slip' }],
  [/medical/i, { file: 'Medical' }],
  [/marital/i, { col: 'marital_status', label: 'Marital status', options: [['SINGLE', 'Single'], ['MARRIED', 'Married'], ['DIVORCED', 'Divorced'], ['WIDOWED', 'Widowed']] }],
  [/religion/i, { col: 'religion', label: 'Religion', options: [['Muslim', 'Muslim'], ['Christian', 'Christian']] }],
  [/mobile|^phone/i, { col: 'phone_number', label: 'Mobile number', hint: '9 and 8 digits' }],
  [/broker/i, { col: 'broker_id', label: 'Broker', brokers: true }],
  [/destination/i, { col: 'destination_country', label: 'Destination country', options: COUNTRIES.map(c => [c, c]) }],
  [/labou?r id/i, { col: 'labor_id', label: 'Labor ID' }],
  [/passport (number|no)/i, { col: 'passport_number', label: 'Passport number' }],
  [/application number/i, { col: 'visa_application_number', label: 'Application number' }],
]
const NUMBER = /^(children_count|weight|height|experience_years|salary)$/
const human = (k) => k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
const snake = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/\bmissing\b|\bnot assigned\b/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** Each missing name → { key, label, col?, file?, options?, brokers?, type } (unknown ones: { label, unknown }). */
export function itemsFor(names, profile = {}) {
  const out = [], seen = new Set()
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (!name) continue
    const hit = KNOWN.find(([re]) => re.test(name))?.[1]
    let it = hit ? { ...hit } : null
    if (!it) {
      const k = snake(name)
      if (k in profile) it = { col: k }
    }
    if (!it) it = { unknown: true, label: name }
    it.key = it.file ? `file:${it.file}` : it.col ? `col:${it.col}` : `x:${name}`
    if (seen.has(it.key)) continue
    seen.add(it.key)
    it.label ||= it.file || human(it.col || name)
    it.type = it.col && NUMBER.test(it.col) ? 'number' : it.col && /date/.test(it.col) ? 'date' : 'text'
    out.push(it)
  }
  return out
}

export default function NeedsFill({ profileId, workflowId = null, cv = false, fields = [], onFileUpdate, onReady, onState }) {
  const [names, setNames] = useState(null)      // null = asking
  const [note, setNote] = useState('')
  const [profile, setProfile] = useState({})
  const [values, setValues] = useState({})
  const [brokers, setBrokers] = useState([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [filled, setFilled] = useState(false)   // the person filled something: the step goes on by itself

  const check = async () => {
    try {
      const p = (await api.get(`/profiles/${profileId}`)).data || {}
      setProfile(p)
      if (cv) {
        const r = (await api.get(`/cv/profile-readiness/${profileId}`)).data || {}
        setNames([...(r.cv_blockers || []), ...(r.missing || [])])
      } else {
        // Only asked, never started (an older main PC without this question answers 404: nothing shown).
        await api.get(`/profiles/${profileId}/automations/${workflowId}/needs`)
        setNames([])
      }
      setNote('')
    } catch (e) {
      const d = e.response?.data || {}
      if (e.response?.status === 404) { setNames([]); setNote(''); return }
      if (Array.isArray(d.missing) && d.missing.length) { setNames(d.missing); setNote('') }
      else { setNames([]); setNote(d.error || e.message) }
    }
  }
  // Asked again whenever a document arrives (her fields change).
  const fileCount = fields.reduce((n, f) => n + (f.files?.length || 0), 0)
  useEffect(() => { check() }, [profileId, workflowId, cv, fileCount]) // eslint-disable-line react-hooks/exhaustive-deps
  // Her details changed (cleared or filled here, on the page or on another PC): the list follows at once.
  useEffect(() => {
    const again = () => api.get(`/profiles/${profileId}`).then(r => setProfile(r.data || {})).catch(() => {})
    window.addEventListener('adal-profile-changed', again)
    const off = onDataChange(['profiles'], again)
    return () => { window.removeEventListener('adal-profile-changed', again); off() }
  }, [profileId])

  const items = useMemo(() => itemsFor(names || [], profile), [names, profile])
  // Her details the step's own list does not name but the Missing card does (asked on 2026-11-23:
  // a pop-up shows both). Shown and saved here too; they never hold the step back.
  const extras = useMemo(() => {
    if (names === null) return []
    const m = missingNow(profile, fields, cv ? 'cv' : workflowId === 'musaned_add_candidate' ? 'musaned' : null, profileId)
    const have = new Set(items.map(i => i.key))
    return [
      ...m.texts.map(t => ({ key: `col:${t.key}`, col: t.key, label: t.label, type: t.type === 'select' ? 'text' : t.type, hint: t.hint, options: t.options?.map(o => [o, o[0] + o.slice(1).toLowerCase()]), extra: true })),
      ...m.files.map(n => ({ key: `file:${n}`, file: n, label: n, extra: true })),
    ].filter(i => !have.has(i.key))
  }, [names, profile, fields, items, cv, workflowId])
  useEffect(() => { if (items.some(i => i.brokers)) api.get('/brokers').then(r => setBrokers(r.data || [])).catch(() => {}) }, [items.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const ready = names !== null && !items.length && !note
  useEffect(() => { onState?.({ ready, asking: names === null, items }) }, [ready, names, items]) // eslint-disable-line react-hooks/exhaustive-deps
  // Everything there after the person filled it in: the step goes on by itself.
  useEffect(() => { if (ready && filled) { setFilled(false); onReady?.() } }, [ready, filled]) // eslint-disable-line react-hooks/exhaustive-deps

  // What a box starts with: living town is her place of birth unless typed otherwise.
  const valueOf = (col) => values[col] ?? (col === 'living_town' ? (profile.place_of_birth || '') : '')
  const save = async () => {
    const body = {}
    for (const it of [...items, ...extras]) if (it.col && String(valueOf(it.col)).trim() !== '') body[it.col] = it.type === 'number' ? Number(valueOf(it.col)) : valueOf(it.col)
    if (!Object.keys(body).length) return toast.error('Choose or type something first')
    setSaving(true)
    setSaveError('')
    try {
      // The normal profile update: saved in this PC's database, synced to every PC, fetched again here.
      await api.put(`/profiles/${profileId}`, body)
      setValues(v => { const n = { ...v }; for (const k of Object.keys(body)) delete n[k]; return n })
      setFilled(true)
      window.dispatchEvent(new Event('adal-profile-changed'))
      toast.success('Saved')
      await check()
    } catch (e) {
      const why = e.response?.data?.error || e.message
      setSaveError(why); toast.error(`Not saved: ${why}`, { duration: 7000 })
    }
    setSaving(false)
  }

  if (names === null) return <p className="py-3 text-sm text-slate-500">Checking what she still needs…</p>
  if (note && !items.length) return <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">{note}</p>
  if (!items.length && !extras.length) return null
  const all = [...items, ...extras]
  const cols = all.filter(i => i.col), files = all.filter(i => i.file), unknown = items.filter(i => i.unknown)
  const input = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm dark:border-slate-600 dark:bg-slate-800'
  return (
    <div className="space-y-4">
      {items.length > 0 && <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Still needed: {items.map(i => i.label).join(', ')}</p>}
      {extras.length > 0 && <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">Missing from her details: {extras.map(i => i.label).join(', ')}</p>}
      {cols.length > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); save() }} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {cols.map(it => (
              <label key={it.key} className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                {it.label}
                {it.options || it.brokers ? (
                  <select className={`${input} mt-1`} value={values[it.col] ?? ''} onChange={e => setValues(v => ({ ...v, [it.col]: e.target.value }))}>
                    <option value="">— Choose —</option>
                    {(it.brokers ? brokers.map(b => [b.id, b.name || b.full_name || `Broker ${b.id}`]) : it.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : (
                  <input className={`${input} mt-1`} type={it.type} placeholder={it.hint || ''} value={valueOf(it.col)}
                    onChange={e => setValues(v => ({ ...v, [it.col]: e.target.value }))} />
                )}
              </label>
            ))}
          </div>
          {saveError && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300" data-testid="needs-save-error">{saveError}</p>}
          <button disabled={saving} className="rounded-xl bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </form>
      )}
      {files.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {files.map(it => {
            const f = fields.find(x => x.name.toLowerCase() === it.file.toLowerCase())
            return f
              ? <div key={it.key} onClickCapture={() => setFilled(true)} onDropCapture={() => setFilled(true)}><FieldCard id={`need-${f.name.replace(/\s+/g, '-')}`} field={f} profileId={profileId} onFileUpdate={onFileUpdate} /></div>
              : <p key={it.key} className="text-sm text-slate-500">{it.file}: add it under Documents on her page.</p>
          })}
        </div>
      )}
      {unknown.length > 0 && <p className="text-xs text-slate-500">Fill in Edit: {unknown.map(i => i.label).join(', ')}</p>}
    </div>
  )
}
