/**
 * Model router. Only useful when Adal Keep actually has 2+ configured
 * models for the same task. Currently DeepSeek is the only working text
 * model, so this is a no-op unless you add a second provider.
 */

import { askJev } from './client.js'

export async function routeModel({ task, candidates, constraints }) {
  if (!candidates || candidates.length < 2) {
    return { model: candidates?.[0] || null, source: 'single' }
  }
  const state = { task, candidates, constraints }
  const { ok, answers } = await askJev(state, {
    model: {
      type: 'Choice',
      options: candidates,
      instructions:
        'Pick the candidate that best fits the task and constraints. ' +
        'Prefer accuracy when constraints.priority is "accuracy", ' +
        'prefer the cheapest when priority is "cost".',
    },
  })
  if (!ok) return { model: candidates[0], source: 'fallback' }
  return { model: answers.model?.choice || candidates[0], source: 'jev' }
}
