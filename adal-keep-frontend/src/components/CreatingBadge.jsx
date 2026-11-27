import { useNavigate, useLocation } from 'react-router-dom'
import { useCreationJobs } from '../lib/creationJobs'

/** A small item on every page while a new profile is being made (the reading runs on the server, the page may be left). Click: back to it. */
export default function CreatingBadge() {
  const jobs = useCreationJobs()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const live = jobs.filter(j => !j.failed)
  if (!live.length || pathname === '/profiles/new') return null
  const reading = live.filter(j => !j.done).length
  const text = reading
    ? `Creating ${reading} profile${reading > 1 ? 's' : ''}… ${live.find(j => !j.done)?.step_text || ''}`
    : `${live.length} passport${live.length > 1 ? 's' : ''} read — finish the profile`
  return (
    <button type="button" data-creating-badge="" onClick={() => navigate('/profiles/new')}
      className="fixed bottom-4 left-4 z-40 flex max-w-[80vw] items-center gap-2 rounded-full bg-sky-600 px-4 py-2 text-xs font-semibold text-white shadow-lg hover:bg-sky-700"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
      {reading ? <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> : <span>✓</span>}
      <span className="truncate">{text}</span>
    </button>
  )
}
