/**
 * Adal Keep Admin on the pretend Supabase (tests/demo-supabase.mjs), in a
 * temporary folder: its own .env, session and ledger files, throwaway signing
 * keys — the real ones in ~/.adal-keep are never read.
 *
 *   node adal-admin/tests/demo.mjs        → prints the address and the password
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { demoSupabase, demoData } from './demo-supabase.mjs'

const ADMIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const free = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

export async function startDemo({ port = null, password = 'demo-pass' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-admin-demo-'))
  const fake = demoSupabase(demoData())
  await new Promise(ok => fake.server.listen(0, '127.0.0.1', ok))
  const dir = path.join(tmp, 'adal-admin'); fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
  for (const f of fs.readdirSync(ADMIN).filter(f => f.endsWith('.mjs'))) fs.copyFileSync(path.join(ADMIN, f), path.join(dir, f))
  for (const f of fs.readdirSync(path.join(ADMIN, 'public'))) fs.copyFileSync(path.join(ADMIN, 'public', f), path.join(dir, 'public', f))
  fs.symlinkSync(path.join(ADMIN, '..', 'adal-keep-backend'), path.join(tmp, 'adal-keep-backend'))
  const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, '.adal-keep'), { recursive: true })
  for (const k of ['update-signing.pem', 'tower-signing.pem']) fs.writeFileSync(path.join(home, '.adal-keep', k), crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  port ||= await free()
  fs.writeFileSync(path.join(dir, '.env'), `SUPABASE_URL=http://127.0.0.1:${fake.server.address().port}\nSUPABASE_SERVICE_KEY=demo\nADAL_LICENSE_KEY=demo-key\n`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, ADMIN_PORT: String(port), ADMIN_REALTIME: '0' }
  delete env.SUPABASE_URL; delete env.SUPABASE_SERVICE_KEY; delete env.ADAL_TOWER_KEY
  const proc = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; proc.stdout.on('data', d => { log += d }); proc.stderr.on('data', d => { log += d })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
  const r = await fetch(base + '/set-password', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${password}&again=${password}` })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  return { base, cookie, password, fake, log: () => log, stop: () => { proc.kill(); fake.server.close(); fs.rmSync(tmp, { recursive: true, force: true }) } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const d = await startDemo({ port: Number(process.argv[2]) || 4188 })
  console.log(`Adal Keep Admin (demo data): ${d.base}  password: ${d.password}`)
  process.on('SIGINT', () => { d.stop(); process.exit(0) })
}
