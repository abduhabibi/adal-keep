/**
 * "What's new" after an update: the 3–5 plain-English bullets Adal published
 * with the release (publish-update.mjs --note), shown once on this PC in a
 * small card until someone closes it (routes/systemUpdate.js /update/whats-new).
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

export default function WhatsNewCard() {
  const [card, setCard] = useState(null)
  useEffect(() => {
    let live = true
    api.get('/system/update/whats-new').then(r => { if (live) setCard(r.data?.whatsNew || null) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!card?.notes?.length) return null
  const close = () => {
    setCard(null)
    api.post('/system/update/whats-new/seen', { sha: card.sha }).catch(() => {})
  }
  return (
    <div role="status" className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 shadow-lg p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-emerald-800 dark:text-emerald-200">
          {card.rollback ? '↩️ Back to the version before' : "✨ What's new"} <span translate="no" className="font-mono text-xs font-normal text-slate-400">{card.short}</span>
        </h3>
        <button type="button" onClick={close} aria-label="Close" className="-mt-1 -mr-1 rounded-md px-2 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">×</button>
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-200">
        {card.notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={close} className="rounded-md bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700">Got it</button>
      </div>
    </div>
  )
}
