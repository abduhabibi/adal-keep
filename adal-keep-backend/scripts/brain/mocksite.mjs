// The mock "site": every robot visit is logged as { girl, pc, phase, t }. Nothing else is shared between the PCs.
import http from 'http'
export async function startMockSite() {
  const visits = []
  const server = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x')
    visits.push({ girl: u.searchParams.get('girl'), pc: u.searchParams.get('pc'), phase: u.pathname.slice(1), t: Date.now() })
    r.end('ok')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base, visits,
    started: (girl) => visits.filter(v => v.phase === 'start' && v.girl === String(girl)),
    ended: (girl) => visits.filter(v => v.phase === 'end' && v.girl === String(girl)),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }),
  }
}
