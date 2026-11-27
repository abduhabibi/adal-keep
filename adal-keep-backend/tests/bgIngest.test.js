// ADAL_BG_INGEST: a profile being made does not belong to the page. The person drops a passport, goes to another page, comes back:
// the reading is still on the server (listed for the "creating 1 profile…" item), its result is there more than once, and a draft of the
// half-typed form is kept until it is thrown away. Off: the old behaviour (the result is handed over once, no list, no draft).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'http'
import express from 'express'
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[k]
const SAMPLE = new URL('./fixtures/sample-passport.jpg', import.meta.url).pathname
const { warmMrzReader, stopMrzReader } = await import('../src/services/quickMrz.js')
after(async () => { await stopMrzReader(); await (await import('../src/services/passportVisual.js')).stopVisualReader() })

async function withServer(fn) {
  const { default: router } = await import('../src/routes/newProfile.js')
  const app = express()
  app.locals.db = () => ({ where: () => ({ first: async () => null }) })
  app.use(express.json())
  app.use('/api', router)
  const server = http.createServer(app).listen(0)
  const base = `http://127.0.0.1:${server.address().port}/api`
  try { await fn(base) } finally { server.close() }
}
const j = async (r) => r.json()
const startRead = async (base) => { const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(SAMPLE)], { type: 'image/jpeg' }), 'p.jpg'); return j(await fetch(`${base}/new-profile/read`, { method: 'POST', body: fd })) }
const until = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 100)) } throw new Error('timed out') }

test('leave the page mid-creation and come back: the job is still there, its result too (more than once)', async () => {
  await warmMrzReader(); await (await import('../src/services/passportVisual.js')).warmVisualReader()
  process.env.SCAN_FIRST_MS = '1'; delete process.env.ADAL_BG_INGEST
  await withServer(async (base) => {
    const first = await startRead(base)
    assert.equal(first.pending, true, 'the page got "pending" and now goes elsewhere (no more polling from it)')
    // another page: the small item asks for the list
    const l1 = await j(await fetch(`${base}/new-profile/jobs`))
    assert.equal(l1.enabled, true); assert.equal(l1.jobs.length, 1); assert.equal(l1.jobs[0].upload, first.upload)
    // ... and the reading finishes with nobody watching
    const l2 = await until(async () => { const l = await j(await fetch(`${base}/new-profile/jobs`)); return l.jobs[0]?.done ? l : null })
    assert.equal(l2.jobs[0].ready, true)
    // back on the create page: the result, twice (the badge's page and the form's page)
    const a = await j(await fetch(`${base}/new-profile/result/${first.upload}`))
    const b = await j(await fetch(`${base}/new-profile/result/${first.upload}`))
    assert.equal(a.fields.passport_number, 'L898902C3'); assert.deepEqual(b.fields, a.fields)
    // thrown away: gone from the list
    await fetch(`${base}/new-profile/jobs/${first.upload}`, { method: 'DELETE' })
    assert.equal((await j(await fetch(`${base}/new-profile/jobs`))).jobs.length, 0)
  })
})

test('the half-typed form is kept as a draft until it is discarded', async () => {
  delete process.env.ADAL_BG_INGEST
  await withServer(async (base) => {
    await fetch(`${base}/new-profile/draft`, { method: 'DELETE' })
    assert.equal((await j(await fetch(`${base}/new-profile/draft`))).draft, null)
    await fetch(`${base}/new-profile/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ form: { full_name: 'A B', labor_id: 'X1' }, step: 'form' }) })
    const d = (await j(await fetch(`${base}/new-profile/draft`))).draft
    assert.equal(d.form.full_name, 'A B'); assert.equal(d.step, 'form')
    await fetch(`${base}/new-profile/draft`, { method: 'DELETE' })
    assert.equal((await j(await fetch(`${base}/new-profile/draft`))).draft, null)
  })
})

test('ADAL_BG_INGEST=0: no list, no draft, the result is handed over once (as before)', async () => {
  process.env.ADAL_BG_INGEST = '0'; process.env.SCAN_FIRST_MS = '1'
  try {
    await withServer(async (base) => {
      const first = await startRead(base)
      assert.equal((await j(await fetch(`${base}/new-profile/jobs`))).jobs.length, 0)
      await until(async () => { const r = await j(await fetch(`${base}/new-profile/result/${first.upload}`)); return r.pending ? null : r })
      assert.equal((await fetch(`${base}/new-profile/result/${first.upload}`)).status, 404)
      await fetch(`${base}/new-profile/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ form: { a: 1 } }) })
      assert.equal((await j(await fetch(`${base}/new-profile/draft`))).draft, null)
    })
  } finally { delete process.env.ADAL_BG_INGEST; delete process.env.SCAN_FIRST_MS }
})
