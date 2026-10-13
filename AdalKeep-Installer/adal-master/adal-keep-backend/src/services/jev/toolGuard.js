/**
 * Pre-action guard. Called BEFORE consequential browser actions.
 *
 * Returns: 'allow' | 'confirm' | 'review' | 'deny'
 * Fallback on Jev failure: 'review' (never silently allow).
 */

import { askJev } from './client.js'

const CONSEQUENTIAL_ACTIONS = new Set([
  'submit_lmis_application',
  'submit_police_certificate',
  'import_labour_contract',
  'submit_musaned_login',
  'delete_profile',
  'delete_account',
])

export async function guardAction({ tool, action, workflow, sideEffect, reversible, evidence, ctx }) {
  if (!CONSEQUENTIAL_ACTIONS.has(action)) {
    return { verdict: 'allow', source: 'skip' }
  }
  const state = {
    tool, action, workflow, sideEffect, reversible,
    evidence: evidence || {},
  }
  const { ok, answers } = await askJev(state, {
    verdict: {
      type: 'Choice',
      options: ['allow', 'confirm', 'review', 'deny'],
      instructions:
        'Pick "deny" if evidence shows a required precondition is missing. ' +
        'Pick "review" if evidence is incomplete but no failure is evident. ' +
        'Pick "confirm" if the action is reversible and evidence is weak. ' +
        'Pick "allow" only when evidence fully supports the action AND it is reversible.',
    },
  })
  if (!ok) return { verdict: 'review', source: 'fallback' }
  return { verdict: answers.verdict?.choice || 'review', source: 'jev' }
}

export function isConsequential(action) {
  return CONSEQUENTIAL_ACTIONS.has(action)
}
