import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'

/**
 * Every document Adal Keep noticed in the last day, live: waiting, being read
 * (and on which step), added to a profile, or not added — and why.
 */
const WHY = {
  other: 'Not a document Adal Keep keeps.',
  low_confidence: 'Could not tell what document this is.',
  passport_unreadable: 'Passport: the two lines at the bottom could not be read. Scan it again — flat, sharp, the whole page.',
  no_profile: 'Passport: no name could be read from it.',
  no_profile_match: 'No profile for this person yet. Profiles are made from passports — add the passport first.',
  no_slip_match: 'Payment slip: no worker with that name.',
  already_ingested: 'Already stored.',
  duplicate_in_field: 'Already on this profile.',
  generated_cv: 'A CV Adal Keep made — not read again.',
  cv_template_source: 'A CV template file.',
  unsupported_ext: 'Not a file type Adal Keep reads.',
  large_pdf: 'PDF larger than 5 MB — not read (books and manuals are usually this big).',
  analyzer_failed: 'Could not be read.',
  'file gone': 'The file was moved or deleted before it was read.',
  'server restart': 'Adal Keep restarted before it was read. Save it again.',
  no_db: 'Could not be read.',
}

const pill = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  processing: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  skipped: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export default function DocumentActivity() {
  const [rows, setRows] = useState(null)
  const [skew, setSkew] = useState(0)       // server clock − this PC's clock
  const [, tick] = useState(0)
  const busy = useRef(false)

  useEffect(() => {
    let alive = true
    let timer
    const load = async () => {
      try {
        const { data } = await api.get('/tasks/documents')
        if (!alive) return
        setRows(data.rows || [])
        setSkew(new Date(data.now).getTime() - Date.now())
        busy.current = (data.rows || []).some(r => r.status === 'pending' || r.status === 'processing')
      } catch { if (alive) setRows(r => r || []) }
      if (alive) timer = setTimeout(load, busy.current ? 2500 : 8000)
    }
    load()
    const sec = setInterval(() => tick(t => t + 1), 1000)
    return () => { alive = false; clearTimeout(timer); clearInterval(sec) }
  }, [])

  const now = Date.now() + skew
  const working = (rows || []).filter(r => r.status === 'pending' || r.status === 'processing').length

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <span className={`w-2.5 h-2.5 rounded-full ${working ? 'bg-sky-500 animate-pulse' : 'bg-emerald-400'}`} />
        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Documents</h3>
        <span className="text-xs text-slate-500">
          {working ? `reading ${working} now` : 'watching Downloads for new files'}
        </span>
      </header>

      {rows === null ? (
        <p className="px-4 py-6 text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No new documents today. Save a passport, slip or photo into Downloads and it shows up here within a few seconds.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700 max-h-[420px] overflow-y-auto">
          {rows.map(r => {
            const res = r.result || {}
            const since = now - new Date(r.started_at || r.created_at).getTime()
            let label, detail
            if (r.status === 'pending') {
              label = 'Waiting'
              detail = r.attempts ? `Trying again (attempt ${r.attempts + 1}) — ${WHY[r.last_error] || r.last_error || ''}` : 'Next in line to be read.'
            } else if (r.status === 'processing') {
              label = `Reading · ${ago(since)}`
              detail = r.stage ? `Now: ${r.stage}` : 'Reading…'
            } else if (r.status === 'done') {
              label = res.created ? 'New profile' : 'Added'
              detail = <>
                {res.docType || 'Document'} → {res.profileId
                  ? <Link to={`/profiles/${res.profileId}`} className="font-semibold text-teal-700 dark:text-teal-300 hover:underline">{res.profileName || `profile #${res.profileId}`}</Link>
                  : 'a profile'}
              </>
            } else {
              label = 'Not added'
              detail = WHY[r.last_error] || r.last_error || 'Not added.'
              if (res.profileId && (r.last_error === 'duplicate_in_field')) {
                detail = <>{detail} <Link to={`/profiles/${res.profileId}`} className="text-teal-700 dark:text-teal-300 hover:underline">{res.profileName || 'Open profile'}</Link></>
              }
            }
            const st = r.status === 'expired' ? 'skipped' : r.status
            return (
              <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className={`mt-0.5 w-28 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold whitespace-nowrap ${pill[st] || pill.skipped}`}>
                  {r.status === 'processing' && <span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500 animate-pulse align-middle" />}
                  {label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-white" title={r.filename}>{r.filename}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{detail}</p>
                </div>
                <span className="shrink-0 text-[11px] text-slate-400">{ago(now - new Date(r.created_at).getTime())} ago</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
