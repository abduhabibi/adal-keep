/**
 * A Companion install's first screen: join the agency (the main PC's number).
 * This PC then gets its own full copy of the agency's data from the main PC
 * (over the office network), and works on it by itself from then on — CVs,
 * readings, edits at once, with the main PC on or off (/api/sync/join-agency).
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

export default function JoinAgency() {
  const [found, setFound] = useState([])
  const [address, setAddress] = useState('')
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)

  useEffect(() => {
    api.get('/sync/find-main').then(r => {
      setFound(r.data.found || [])
      setAddress(a => a || r.data.found?.[0]?.url || r.data.main_url || '')
    }).catch(() => {})
  }, [])

  const join = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const r = await api.post('/sync/join-agency', { main_url: address, number }, { timeout: 30 * 60 * 1000 })
      setDone(r.data)
      // The server starts again with the copy in place: wait for it, then open.
      const wait = async () => {
        for (let i = 0; i < 120; i++) {
          await new Promise(res => setTimeout(res, 2000))
          try { const st = await api.get('/setup/status'); if (st.data.state !== 'join') { window.location.reload(); return } } catch {}
        }
      }
      wait()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <form onSubmit={join} className="panel w-full max-w-md p-6 space-y-4">
        <h1 className="text-xl font-bold text-slate-800 dark:text-white">Join your agency</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This PC gets its own full copy of the agency's data from the main PC, and works on it by itself:
          CVs, passports, edits and uploads happen here at once, even when the main PC is off. Everything goes
          back to the other PCs by itself.
        </p>
        {done ? (
          <div className="rounded-xl bg-teal-50 dark:bg-teal-900/30 p-4 text-sm text-teal-800 dark:text-teal-200">
            Joined {done.main}. The copy is going in — Adal Keep opens again by itself in a moment. The documents follow in the background, smallest first.
          </div>
        ) : (
          <>
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">The main PC</span>
              <input value={address} onChange={e => setAddress(e.target.value)} placeholder="http://192.168.1.10:4000"
                className="mt-1 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-sm" />
              {found.length > 0 && <span className="text-xs text-slate-400">Found on the office network: {found.map(f => f.name || f.url).join(', ')}</span>}
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">The main PC's number (in its Settings)</span>
              <input value={number} onChange={e => setNumber(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoFocus
                className="mt-1 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-lg tracking-widest" />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy || !address || number.length < 5}
              className="w-full px-4 py-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-semibold disabled:opacity-50">
              {busy ? 'Copying the agency\'s data…' : 'Join'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}
