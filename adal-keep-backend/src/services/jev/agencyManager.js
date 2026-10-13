// src/services/jev/agencyManager.js (NEW)
import { askJev } from './client.js'

/**
 * Given a batch of profiles, decide what each one needs next.
 * Returns an object: { [profileId]: { next_action, reason } }
 */
export async function decideAgencyActions(profiles) {
  // Build a compact state per profile — no secrets, no file contents
  const state = profiles.map(p => ({
    id: p.id,
    name: p.full_name,
    destination: p.destination_country,
    has_labor_id: !!p.labor_id,
    has_order_id: !!p.order_id,
    files: p.files_present,        // e.g. ['Passport','Photo','Slip']
    last_action: p.last_status,    // 'never' | 'done' | 'failed'
    cv_generated: p.cv_count > 0,
  }))

  const { ok, answers } = await askJev(
    { agency_state: state },
    {
      // one Choice question per profile, keyed by id
      ...Object.fromEntries(state.map(p => [
        `p_${p.id}`,
        {
          type: 'Choice',
          options: ['make_cv', 'submit_police_certificate', 'send_message', 'wait'],
          instructions:
            'make_cv: profile has photo + full body photo + all CV fields. ' +
            'submit_police_certificate: Kuwait + labor_id + order_id + Passport+Photo+Slip present + no prior run. ' +
            'send_message: profile missing data or stalled for >7 days. ' +
            'wait: not enough data yet.',
        },
      ])),
    }
  )

  if (!ok) return { source: 'fallback', decisions: [] }

  const decisions = state.map(p => ({
    profileId: p.id,
    profileName: p.name,
    next_action: answers[`p_${p.id}`]?.choice || 'wait',
  }))

  return { source: 'jev', decisions }
}