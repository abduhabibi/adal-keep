/**
 * Task routing for ambiguous workflow states.
 * Fallback on Jev failure: 'proceed_fast' (least disruptive).
 */

import { askJev } from './client.js'

export async function routeTask({ workflow, step, state, riskLevel }) {
  const { ok, answers } = await askJev(
    { workflow, step, state, riskLevel },
    {
      route: {
        type: 'Choice',
        options: ['proceed_fast', 'deep_review', 'split_task', 'block'],
        instructions:
          'proceed_fast for routine states. deep_review when evidence is mixed. ' +
          'split_task when the step covers multiple independent sub-goals. ' +
          'block when a hard precondition is missing or risk is high.',
      },
    }
  )
  if (!ok) return { route: 'proceed_fast', source: 'fallback' }
  return { route: answers.route?.choice || 'proceed_fast', source: 'jev' }
}
