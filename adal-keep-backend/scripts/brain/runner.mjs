// The robot run of the brain test: the real worker queue (ADAL_BRAIN_TEST_RUNNER) calls this instead of a browser.
// It visits the mock site (start, a wait, end) as the PC it runs on. The rig writes what it needs into the file named by ADAL_BRAIN_CTL:
// { site: 'http://127.0.0.1:port', runMs, girls: { '<profile id>': '<girl number>' } }.
import fs from 'fs'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export default async function run(db, job) {
  const ctl = JSON.parse(fs.readFileSync(process.env.ADAL_BRAIN_CTL, 'utf8'))
  const girl = ctl.girls?.[job.profile_id] ?? job.profile_id, pc = process.env.ADAL_PC_NAME
  const visit = (phase) => fetch(`${ctl.site}/${phase}?girl=${girl}&pc=${pc}`).catch(() => {})
  await visit('start')
  for (const end = Date.now() + (ctl.runMs || 400); Date.now() < end;) await sleep(150)
  await visit('end')
  return { ok: true, note: `mock run of girl ${girl} on ${pc}` }
}
