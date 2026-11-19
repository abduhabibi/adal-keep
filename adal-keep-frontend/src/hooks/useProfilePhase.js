import { useEffect, useState } from 'react'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import { afterInOrder, phaseOf } from '../lib/phase'

/**
 * One profile's phase (the Profiles page's tab she is in), for the buttons it
 * shows (lib/stageActions.js). { phase, after }: phase is null until known.
 */
export default function useProfilePhase(profile) {
  const id = profile?.id
  const [steps, setSteps] = useState(null)
  const [order, setOrder] = useState(() => { try { return JSON.parse(localStorage.getItem('adal-journey-order') || '[]') || [] } catch { return [] } })
  useEffect(() => {
    api.get('/settings/journey-order').then(r => { if (Array.isArray(r.data?.order)) setOrder(r.data.order) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!id) return
    let alive = true
    const load = () => api.get(`/profiles/${id}/journey`).then(({ data }) => {
      if (alive) setSteps(Object.fromEntries([...(data?.embassy || []), ...(data?.extra || [])].map(x => [x.key, x.state])))
    }).catch(() => {})
    load()
    const off = onDataChange(['profiles', 'automation_queue', 'generated_cvs'], load, 3000)
    window.addEventListener('adal-profile-changed', load)
    return () => { alive = false; off(); window.removeEventListener('adal-profile-changed', load) }
  }, [id])
  const after = afterInOrder(order)
  return { phase: steps && profile ? phaseOf(steps, profile, after) : null, after }
}
