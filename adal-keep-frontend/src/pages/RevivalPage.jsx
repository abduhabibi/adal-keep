import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'

export default function RevivalPage() {
  const { unlock } = useAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setBusy(true)
    try { await unlock(code); toast.success('Access restored — your data is back!'); setTimeout(() => window.location.reload(), 800) }
    catch (err) { toast.error(err.response?.data?.error || 'Invalid code') }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <form onSubmit={submit} className="max-w-md w-full bg-slate-900 rounded-2xl shadow-2xl border border-red-900/50 p-8 space-y-4 text-center">
        <div className="text-5xl mb-2">🔐</div>
        <h1 className="text-xl font-bold text-white">System Archived</h1>
        <p className="text-sm text-slate-400">This installation has reached the end of its period. Your data is safely encrypted and will be fully restored with a valid access code.</p>
        <textarea required value={code} onChange={e => setCode(e.target.value)} placeholder="Paste your access code here..." rows={4} className="w-full p-3 rounded-xl border border-slate-700 bg-slate-800 text-slate-100 text-xs font-mono" />
        <button disabled={busy} className="w-full py-3 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors">
          {busy ? 'Restoring...' : 'Restore Access →'}
        </button>
      </form>
    </div>
  )
}
