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
    claims: missing('the run claims / leases (Umar: table and columns)'),
    results: missing('the newest finished result per girl on Main'),
    close: async () => {},
  }
}
