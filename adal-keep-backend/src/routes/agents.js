/**
 * agents.js — read-only view of the automation agent pool.
 *
 *   GET /api/agents → { agents: [{ id, label, color, state, current }] , brave }
 *
 * The frontend polls this to show which coloured agent is handling which
 * workflow card (e.g. the Musaned button turning green / blue / purple).
 */
import { Router } from 'express'
import { listAgents, setAssignment } from '../services/agentRegistry.js'
import { getAgentStatus } from '../services/braveAgent.js'
import { drainQueue, wakeIdleAgents } from '../services/worker.js'

const router = Router()

router.get('/', (req, res) => {
  res.json({ agents: listAgents(), brave: getAgentStatus() })
})

/**
 * Manually assign an agent to a portal.
 *   PATCH /api/agents/:laneId   { assignment: 'musaned' | 'lmis' | null }
 *
 * A pinned agent only claims jobs for that portal and keeps its logged-in tab,
 * so consecutive Musaned (or LMIS) jobs continue in the same session without
 * logging in again. Passing null (or omitting) clears it back to "any".
 */
router.patch('/:laneId', async (req, res) => {
  try {
    const laneId = Number(req.params.laneId)
    if (!Number.isFinite(laneId)) return res.status(400).json({ error: 'bad laneId' })
    const { assignment } = req.body || {}
    const agent = setAssignment(laneId, assignment)
    // Make the change take effect immediately: top up the pool and wake idles.
    try {
      const db = req.app.locals.db
      if (db) drainQueue(db).catch(() => {})
      wakeIdleAgents()
    } catch {}
    res.json({ ok: true, agent })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
