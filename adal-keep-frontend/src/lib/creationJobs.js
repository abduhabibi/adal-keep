import { useEffect, useState } from 'react'
import api from '../services/api'

// The readings the server keeps for new profiles (routes/newProfile.js, ADAL_BG_INGEST): in progress or waiting for their profile.
// Every page can show the small "creating 1 profile…" item from this; 'adal-creation' asks for a look at once.
export const askCreations = () => { try { window.dispatchEvent(new Event('adal-creation')) } catch {} }

export function useCreationJobs(everyMs = 4000) {
  const [jobs, setJobs] = useState([])
  useEffect(() => {
    if (window.__ADAL_CLOUD || import.meta.env.VITE_ADMIN) return
    let alive = true, timer
    const look = async () => {
      try { const r = await api.get('/new-profile/jobs', { adalNoCache: true, timeout: 8000 }); if (alive) setJobs(r.data?.jobs || []) } catch {}
      if (alive) timer = setTimeout(look, everyMs)
    }
    const now = () => { clearTimeout(timer); look() }
    look()
    window.addEventListener('adal-creation', now)
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('adal-creation', now) }
  }, [everyMs])
  return jobs
}
