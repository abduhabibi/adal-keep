// Route-level timings for docs/speed.md, on a scratch database (never the
// agency's): no .env, no keys, no Supabase, no Telegram.
//   node scripts/bench-speed.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import knexLib from 'knex'
import sharp from 'sharp'

for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|SUPABASE|TELEGRAM|GEMINI|JEV/i.test(k)) delete process.env[k]
// Gemini's place-of-birth question, simulated: a made-up key that never leaves
// this process, and its answer after GEMINI_MS (a typical image call on an office line).
const GEMINI_MS = Number(process.env.BENCH_GEMINI_MS || 5000)
process.env.GEMINI_API_KEY = 'bench-not-a-key'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (!/generativelanguage|googleapis/.test(String(url))) return realFetch(url, opts)
  await new Promise(r => setTimeout(r, GEMINI_MS))
  const text = JSON.stringify({ place_of_birth: 'ADDIS ABABA', region: 'Addis Ababa', date_of_issue: '2007-04-16' })
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { headers: { 'Content-Type': 'application/json' } })
}
const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bench-'))
const db = knexLib({ client: 'sqlite3', connection: { filename: path.join(scratch, 'bench.sqlite') }, useNullAsDefault: true })
await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('passport_number'); t.string('labor_id'); t.string('updated_at') })

const app = express()
app.locals.db = db
app.use(express.json())
app.use('/api', (await import('../src/routes/newProfile.js')).default)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api`
const t = () => performance.now()
const passport = process.argv[2] || path.join(here, '..', 'tests', 'fixtures', 'sample-passport.jpg')
const buf = fs.readFileSync(passport)

async function read() {
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'passport.jpg')
  const a = t()
  const r = await (await fetch(`${base}/new-profile/read`, { method: 'POST', body: fd })).json()
  return { ms: Math.round(t() - a), r }
}
const out = {}
let x = await read(); out.read_cold = x.ms; out.number = x.r.fields?.passport_number; out.place_pending = x.r.place_pending
x = await read(); out.read_warm = x.ms
let a = t()
const pl = await (await fetch(`${base}/new-profile/place/${x.r.upload}`)).json()
out.place_after_form = Math.round(t() - a); out.place = pl.fields?.place_of_birth
// As before: the answer waited for the place (the same reading, place in line).
const { analyzeWithMineru } = await import('../src/services/mineruClassifier.js')
fs.writeFileSync(path.join(scratch, 'p.jpg'), buf)
a = t(); const old = await analyzeWithMineru(path.join(scratch, 'p.jpg'), { db }); out.read_place_inline = Math.round(t() - a); out.old_place = old.fields?.place_of_birth
await fetch(`${base}/new-profile/warm`, { method: 'POST' }).catch(() => {})
console.log(JSON.stringify(out))
server.close(); await db.destroy(); fs.rmSync(scratch, { recursive: true, force: true })
process.exit(0)
