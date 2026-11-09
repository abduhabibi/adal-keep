/**
 * The agency's plan (backend services/plans.js): which features are on, off,
 * or offered by Adal Keep. Kept on the device like the other pages' data.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import { cachedGet } from './deviceCache'

let shared = null
const listeners = new Set()
const publish = (p) => { shared = p; listeners.forEach(fn => fn(p)) }

export async function loadPlan({ fresh = false } = {}) {
  if (fresh) {
    const { data } = await api.post('/plan/refresh')
    publish(data)
    return data
  }
  const data = await cachedGet('/plan', { onSaved: (d) => { if (!shared) publish(d) } })
  publish(data)
  return data
}

export function usePlan() {
  const [plan, setPlan] = useState(shared)
  useEffect(() => {
    listeners.add(setPlan)
    if (!shared) loadPlan().catch(() => {})
    return () => listeners.delete(setPlan)
  }, [])
  return plan
}

/** The feature a robot belongs to, when this plan does not have it (else null). */
export function lockedFor(plan, workflowId) {
  const f = plan?.features?.find(x => (x.workflows || []).includes(workflowId))
  return f && f.state !== 'on' ? f : null
}

export const planName = (plan, key) => plan?.plans?.find(p => p.key === key)?.name || key

export async function wantFeature(key) {
  await api.post('/plan/want', { feature: key })
}
