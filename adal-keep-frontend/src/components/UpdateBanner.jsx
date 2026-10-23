/**
 * The "new version" banner on every page. The server looks for a new version
 * every 30 minutes (routes/systemUpdate.js); one update installs the newest
 * version however many changes were published, so the banner lists all of
 * them and shows how to update.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

const LATER_KEY = 'adal-update-later'
const later = () => { try { return JSON.parse(localStorage.getItem(LATER_KEY) || 'null') } catch { return null } }

export default function UpdateBanner() {
  const [n, setN] = useState(null)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState('') // '' | 'installing' | 'restarting' | 'error'
  const [msg, setMsg] = useState('')
  const [hiddenFor, setHiddenFor] = useState(later())

  const load = () => api.get('/system/update/notice').then(r => setN(r.data)).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  if (!n) return null
  const busy = phase === 'installing' || phase === 'restarting' || n.applying
  if (!n.hasUpdate && !busy && phase !== 'error') return null
  // "Later": hidden for 4 hours for this version; a newer one shows again.
  if (!busy && phase !== 'error' && hiddenFor && hiddenFor.sha === n.latest?.sha && Date.now() < hiddenFor.until) return null

  const update = async () => {
    if (n.running > 0 && !confirm(`${n.running} automation run(s) are working now. Updating restarts Adal Keep and stops them (they can be started again). Update now?`)) return
    setPhase('installing'); setMsg('')
    try {
      const r = await api.post('/system/update/apply', null, { timeout: 15 * 60 * 1000 })
      setMsg(r.data?.message || '')
      setPhase('restarting')
      // The server restarts: reload once it answers again.
      const t0 = Date.now()
      const wait = setInterval(async () => {
        try { await api.get('/health', { timeout: 3000 }); if (Date.now() - t0 > 6000) { clearInterval(wait); location.reload() } } catch {}
        if (Date.now() - t0 > 5 * 60 * 1000) clearInterval(wait)
      }, 3000)
    } catch (e) {
      if (e?.response?.status === 409) { setPhase('restarting'); setMsg(e.response.data.error); return }
      setPhase('error'); setMsg(e?.response?.data?.error || e.message)
    }
  }

  return (
    <div translate="no" className="bg-teal-50 dark:bg-teal-900/30 border-b border-teal-200 dark:border-teal-800 px-4 py-2 text-sm text-teal-900 dark:text-teal-100">
      <div className="flex flex-wrap items-center gap-3">
        {busy ? (
          <span>⏳ {phase === 'restarting' ? 'Update installed — Adal Keep restarts and this page reloads by itself. Wait about a minute.' : 'Installing the update… (1–3 minutes, do not close Adal Keep)'}</span>
        ) : phase === 'error' ? (
          <span className="text-red-700 dark:text-red-300">The update did not install: {msg}</span>
        ) : (
          <span>🆕 <b>A new version of Adal Keep is ready</b> — {n.count > 1 ? `${n.count} changes` : 'one change'}, installed together in one update.</span>
        )}
        {!busy && (
          <>
            <button type="button" onClick={() => setOpen(o => !o)} className="underline">{open ? 'Hide' : 'What is new · how to update'}</button>
            <button type="button" onClick={update} className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white hover:bg-teal-700">Update now</button>
            {phase !== 'error' && (
              <button type="button" className="text-xs opacity-70 hover:opacity-100" onClick={() => {
                const v = { sha: n.latest?.sha, until: Date.now() + 4 * 3600 * 1000 }
                try { localStorage.setItem(LATER_KEY, JSON.stringify(v)) } catch {}
                setHiddenFor(v)
              }}>Later</button>
            )}
          </>
        )}
      </div>
      {open && !busy && (
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div>
            <p className="font-semibold mb-1">How to update</p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>Finish what you are typing. Wait until no automation run is working{n.running ? ` (now: ${n.running} working)` : ''}.</li>
              <li>Press <b>Update now</b> — once is enough, even when many changes are listed.</li>
              <li>Wait 1–3 minutes. Adal Keep restarts and the page reloads by itself. Profiles, documents and settings stay.</li>
              <li>Employee PCs need nothing: they open the main PC's Adal Keep, which is now new.</li>
              <li>No internet now? Run “2 - Install Adal Main.exe” from the newest USB instead.</li>
            </ol>
          </div>
          <div>
            <p className="font-semibold mb-1">What is new</p>
            <ul className="space-y-0.5 max-h-48 overflow-y-auto pr-2">
              {(n.changes || []).map(c => (
                <li key={c.short} className="text-xs"><span className="text-slate-500">{c.date ? new Date(c.date).toLocaleDateString() : ''}</span> {c.message}</li>
              ))}
            </ul>
            {n.note && <p className="text-xs mt-1 opacity-80">{n.note}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
