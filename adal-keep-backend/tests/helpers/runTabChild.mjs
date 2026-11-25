// A robots process of its own for restartReuse.test.js: node runTabChild.mjs <ws> <run id> <do> [busy ids]
import puppeteer from 'puppeteer-core'
const [ws, id, what, busy = ''] = process.argv.slice(2)
const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null })
const tm = await import('../../src/services/tabManager.js')
const busyRuns = new Set(busy.split(',').filter(Boolean).map(Number).concat(Number(id)))
const before = new Set(b.targets().map(t => t._targetId))
const p = await tm.openRunTab(b, Number(id), { workflowId: 'musaned_check_chosen', busyRuns, keepRuns: new Set([Number(id)]) })
const out = { url: p.url(), target: p.target()._targetId, isNew: !before.has(p.target()._targetId) }
if (what === 'finish' || what === 'pause') {
  await p.goto('https://tawtheeq.musaned.com.sa/hr-pool')
  await p.click('#q'); await p.keyboard.type('EP1234567')
  if (what === 'finish') tm.forgetRunTab(Number(id)); else tm.handTabToPerson(p)
  await new Promise(r => setTimeout(r, 500))
}
console.log('OUT ' + JSON.stringify(out))
process.exit(0)      // the process ends (killed, restarted): nothing of what it knew is left
