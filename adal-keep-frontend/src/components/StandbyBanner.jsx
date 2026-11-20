/**
 * "This PC stands in for the main PC" (asked on 2026-11-20): the main PC is
 * away and an Adal Companion opened its own copy of the agency (adal-companion
 * standby.go). Everything works here — robots, AI chat, backups, phones — and
 * when the main PC is back, all of it goes to the main PC by itself.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

export default function StandbyBanner() {
  const [h, setH] = useState(null)
  useEffect(() => {
    if (window.__ADAL_CLOUD) return
    let off = false
    const look = () => api.get('/health').then(r => { if (!off) setH(r.data) }).catch(() => {})
    look()
    const t = setInterval(look, 60000)
    return () => { off = true; clearInterval(t) }
  }, [])
  if (!h?.acting) return null
  const since = h.acting_since ? new Date(h.acting_since) : null
  return (
    <div className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 shadow-sm dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200" translate="no">
      <b>🏢 The main PC is away — this Companion stands in for it</b>
      {since && !Number.isNaN(since.getTime()) && <> since {since.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</>}.
      {' '}Everything works as usual. When the main PC is back, all the work done here goes to it by itself.
    </div>
  )
}
