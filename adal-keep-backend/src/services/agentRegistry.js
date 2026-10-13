/**
 * agentRegistry.js — shared, in-memory registry of automation "agents".
 *
 * WHAT IS AN AGENT?
 * -----------------
 * Every worker that runs an automation job is an "agent". Agents are numbered
 * and each number has a fixed COLOUR so the operator can tell at a glance which
 * agent picked up a task:
 *
 *     Agent 1 = green
 *     Agent 2 = blue
 *     Agent 3 = purple
 *     Agent 4 = orange
 *     Agent 5 = pink
 *     ... (palette cycles)
 *
 * The registry is the single place agents "know each other" from: the worker
 * registers an agent when it goes to work, updates it while it runs a job, and
 * frees it when idle. The frontend polls GET /api/agents and paints the colours.
 *
 * Pure in-memory + process-local, so it is trivially safe cross-platform.
 */

// Colour palette, index 0 → Agent 1. `key` must match the frontend colour map.
// Ten distinct colours — one per agent in the default 10-agent pool.
const PALETTE = [
  { key: 'green',  name: 'Green',  hex: '#10b981' }, // Agent 1
  { key: 'blue',   name: 'Blue',   hex: '#3b82f6' }, // Agent 2
  { key: 'purple', name: 'Purple', hex: '#8b5cf6' }, // Agent 3
  { key: 'orange', name: 'Orange', hex: '#f97316' }, // Agent 4
  { key: 'pink',   name: 'Pink',   hex: '#ec4899' }, // Agent 5
  { key: 'teal',   name: 'Teal',   hex: '#14b8a6' }, // Agent 6
  { key: 'red',    name: 'Red',    hex: '#ef4444' }, // Agent 7
  { key: 'indigo', name: 'Indigo', hex: '#6366f1' }, // Agent 8
  { key: 'cyan',   name: 'Cyan',   hex: '#06b6d4' }, // Agent 9
  { key: 'amber',  name: 'Amber',  hex: '#f59e0b' }, // Agent 10
]

// Who an agent is "specialised" for. `null`/`'any'` = takes any job. An agent
// assigned to `'musaned'` (or `'lmis'`) only ever picks up jobs for that
// portal, which is what lets it keep ONE logged-in tab and continue working
// person after person without logging in again.
export const ASSIGNMENTS = ['musaned', 'lmis']

/** Colour descriptor for a 0-based agent index (cycles past the palette). */
export function colorForIndex(i) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]
}

export function colorForKey(key) {
  return PALETTE.find(c => c.key === key) || PALETTE[0]
}

// laneId -> agent record
const _agents = new Map()

/** Create (once) and return the agent record for a lane id. */
export function ensureAgent(laneId) {
  const n = Number(laneId)
  if (_agents.has(n)) return _agents.get(n)
  const color = colorForIndex(n - 1)
  const agent = {
    id: `agent-${n}`,
    laneId: n,
    index: n,                       // 1-based for humans
    label: `Agent ${n}`,
    color,
    state: 'idle',                  // idle | working | paused | stopping
    current: null,                  // { runId, workflowId, profileId, profileName, startedAt }
    assignment: null,               // null (any) | 'musaned' | 'lmis'  — operator-set
    alive: true,
    startedAt: null,
    updatedAt: Date.now(),
  }
  _agents.set(n, agent)
  return agent
}

/** Patch an agent record (auto-creates it if missing). */
export function updateAgent(laneId, patch) {
  const a = ensureAgent(laneId)
  Object.assign(a, patch, { updatedAt: Date.now() })
  return a
}

export function removeAgent(laneId) {
  _agents.delete(Number(laneId))
}

/**
 * Set (or clear) an agent's portal assignment. Anything that isn't a known
 * peer key ('musaned' / 'lmis') clears it back to "any".
 * @returns the updated agent record
 */
export function setAssignment(laneId, assignment) {
  const val = ASSIGNMENTS.includes(assignment) ? assignment : null
  return updateAgent(laneId, { assignment: val })
}

export function getAgent(laneId) {
  return _agents.get(Number(laneId)) || null
}

/** Snapshot for the UI / API. */
export function listAgents() {
  return [..._agents.values()]
    .sort((a, b) => a.laneId - b.laneId)
    .map(a => ({
      id: a.id,
      laneId: a.laneId,
      index: a.index,
      label: a.label,
      color: a.color,
      state: a.state,
      current: a.current,
      assignment: a.assignment || null,
      alive: a.alive !== false,
      startedAt: a.startedAt,
      updatedAt: a.updatedAt,
    }))
}

/** Agents currently working the given workflow id (used to colour the cards). */
export function agentsWorkingOn(workflowId) {
  return listAgents().filter(a => a.current && a.current.workflowId === workflowId)
}

export function idleAgents() {
  return listAgents().filter(a => a.state === 'idle')
}
