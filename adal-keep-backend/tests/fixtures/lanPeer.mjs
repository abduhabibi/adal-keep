// A second PC for tests/lanUpdateBoth.test.js: its own process, its own kept
// release (ADAL_LAN_RELEASE_DIR), the same LAN routes as a real PC.
//   node lanPeer.mjs <dir> <public-key.pem>           serves it, prints "PORT <n>"
//   then on stdin: "pull <base>" — takes a newer release from that PC (all pieces), prints "PULLED <sha>" or "NOPE <why>"
import fs from 'fs'
import readline from 'readline'

const [dir, pubFile] = process.argv.slice(2)
process.env.ADAL_LAN_RELEASE_DIR = dir
const U = await import('../../src/services/updateChannel.js')
U._setVerifyKeyForTests(fs.readFileSync(pubFile, 'utf8'))
U._setDownloadDefaultsForTests({ backoff: 10, tries: 2 })
const L = await import('../../src/services/lanRelease.js')
L.setAgencyNumbers(['470401'])
const express = (await import('express')).default
const app = express()
app.use(express.json())
const r = express.Router()
L.lanRoutes(r)
app.use('/pc', r)
const srv = app.listen(0, '127.0.0.1', () => console.log(`PORT ${srv.address().port}`))

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const [cmd, base] = line.trim().split(/\s+/)
  if (cmd !== 'pull') return
  try {
    const mine = L.current()?.manifest || null
    L.peers.set(base, { sha: '', published_at: '', at: Date.now() })
    const env = await L.newestFromPeers(mine, { extra: false })
    if (!env) return console.log('NOPE nothing newer and signed')
    for (const p of L.piecesOf(env.manifest)) await L.fetchPiece(env.manifest, p, null, { bases: [base], cloud: false })
    await L.recordInstalled(env)
    console.log(`PULLED ${env.manifest.sha}`)
  } catch (e) { console.log(`NOPE ${e.message}`) }
})
