/**
 * The REAL brain adapter — the one file Yusuf (robots process on Companions) and Umar (run claims + sync) fill in.
 * It has the same methods as scripts/brain/reference.mjs (addPC, enqueue, off, on, cut, heal, rows, claims, results, close), but drives
 * the real code: real instances of Adal Keep (a Main and a Companion, scratch databases, mock sites), the real claim / lease / sync.
 * Each method that is not built yet throws NotBuilt('what is missing'): the scenario that needs it is reported BLOCKED, not failed.
 */
export class NotBuilt extends Error { constructor(what) { super(what); this.notBuilt = true } }
const missing = (what) => () => { throw new NotBuilt(what) }

export async function makeRealBrain({ site } = {}) {
  void site
  return {
    name: 'real',
    addPC: missing('start a real Main and a real Companion instance on scratch data (ADAL_ISOLATED=1, own port, own SQLITE_PATH) and join them'),
    enqueue: missing('a robot run started in a Companion window and queued by the real worker (POST /api/profiles/:id/automations/:wf/start)'),
    off: missing('stop one instance (its robots process too)'),
    on: missing('start it again'),
    cut: missing('cut the network between two instances (a gate in front of their sync / robots calls)'),
    heal: missing('put it back'),
    rows: missing('automation_queue rows of one instance'),
    // Umar: built (services/runClaims.js). Needs an instance with its address (`pc.url`, from addPC).
    claims: async (pc) => {
      if (!pc?.url) throw new NotBuilt('an instance with its url (addPC)')
      const r = await fetch(`${pc.url}/api/run-claims`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error(`${pc.url}/api/run-claims answered ${r.status}`)
      return (await r.json()).map(c => ({ key: c.key, pc_id: c.pc_id, pc_name: c.pc_name, run_id: c.run_id, lease_s: c.lease_s, via: c.via }))
    },
    results: missing('the newest finished result per girl on Main'),
    close: async () => {},
  }
}
