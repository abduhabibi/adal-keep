// fix-programs.mjs — run by fix-this-pc.ps1 on a Companion (C:\AdalKeepCompanion): its programs
// (adal-companion.exe, AdalKeep.exe, adal-agent.exe) from the release on the USB. The release must
// be signed by Adal (checked with Adal Keep's own code: <backend>\src\services\updateChannel.js) and
// each program must match its SHA-256 in that signed manifest. The programs must not be running.
//   node fix-programs.mjs <release folder> <Companion folder> <backend folder>
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { pathToFileURL } from 'url'
const [release, root, backend] = process.argv.slice(2)
const { verifyManifest } = await import(pathToFileURL(path.join(backend, 'src', 'services', 'updateChannel.js')).href)
const { manifest, signature } = JSON.parse(fs.readFileSync(path.join(release, 'current.json'), 'utf8'))
if (!verifyManifest(manifest, signature)) { console.log('PROGRAMS-ERROR the release on the USB is not signed by Adal: nothing installed'); process.exit(1) }
const x86 = process.arch === 'ia32' || process.env.PROCESSOR_ARCHITECTURE === 'x86' && !process.env.PROCESSOR_ARCHITEW6432
const list = (x86 && manifest.programs_x86?.length ? manifest.programs_x86 : manifest.programs) || []
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
let n = 0
for (const p of list) {
  if (!['AdalKeep.exe', 'adal-companion.exe', 'adal-agent.exe'].includes(p.name)) continue
  const dest = path.join(root, p.name)
  if (!fs.existsSync(dest)) continue
  if (sha(dest) === p.sha256) { console.log(`PROGRAM ${p.name} already the release's`); continue }
  const piece = path.join(release, 'files', p.sha256)
  if (!fs.existsSync(piece) || sha(piece) !== p.sha256) { console.log(`PROGRAMS-ERROR ${p.name}: not on the USB (or damaged)`); continue }
  fs.rmSync(`${dest}.old`, { force: true })
  fs.renameSync(dest, `${dest}.old`)
  try { fs.copyFileSync(piece, dest) } catch (e) { fs.renameSync(`${dest}.old`, dest); console.log(`PROGRAMS-ERROR ${p.name}: ${e.message}`); continue }
  fs.rmSync(`${dest}.old`, { force: true })
  console.log(`PROGRAM ${p.name} installed (${manifest.short})`)
  n++
}
console.log(`PROGRAMS-TOTAL ${n}`)
