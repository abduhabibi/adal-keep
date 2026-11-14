/**
 * During a move (Settings → Transitions): a girl already made as a profile
 * whose files have not come yet shows "Prioritize". Pressed, the move reads her
 * record and downloads her files next, then goes on with everyone else.
 * One small question to the PC every 5 s, shared by every button on the page.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

let ids = new Set(), timer = null
const subs = new Set()
async function poll() {
  try {
    const r = await api.get('/transitions/waiting-files', { adalNoCache: true })
    const next = new Set(r.data?.profileIds || [])
    const same = next.size === ids.size && [...next].every(x => ids.has(x))
    ids = next
    if (!same) subs.forEach(f => f(ids))
  } catch {}
}
/** The profile ids waiting for their files (empty when no move runs). */
export function useWaitingFiles() {
  const [v, setV] = useState(ids)
  useEffect(() => {
    subs.add(setV)
    if (!timer) { poll(); timer = setInterval(poll, 5000) }
    return () => { subs.delete(setV); if (!subs.size) { clearInterval(timer); timer = null } }
  }, [])
  return v
}

export default function PrioritizeButton({ profileId, className = '' }) {
  const waiting = useWaitingFiles()
  const [asked, setAsked] = useState(false)
  if (!waiting.has(Number(profileId))) return null
  const go = async (e) => {
    e.stopPropagation()
    try {
      await api.post(`/transitions/prioritize/${profileId}`)
      setAsked(true)
      toast.success('Her files are coming next')
    } catch (er) { toast.error(er?.response?.data?.error || 'Could not prioritize') }
  }
  return (
    <button type="button" onClick={go} disabled={asked}
      title="Her files have not been copied yet: copy hers now, then the move goes on"
      className={`rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-amber-600 disabled:opacity-60 ${className}`}>
      {asked ? '⏳ Coming next…' : '⚡ Prioritize'}
    </button>
  )
}
