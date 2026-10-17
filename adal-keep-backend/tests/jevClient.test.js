/**
 * jevClient.test.js — the JEV callers (agency manager, Musaned decisions) were
 * written for an old SDK and never reached JEV. askJev() now translates their
 * question shapes for SDK 0.7's systemOne. The network is stubbed: nothing is
 * sent to TypeSafe.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || 'test-key'
process.env.JEV_ENABLED = 'true'

const sent = []
let reply = () => ({ status: 200, body: { model: 'jev-test', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } })
// The SDK compresses larger request bodies: read them like the API would.
async function bodyJson(init) {
  const b = init.body
  if (typeof b === 'string') return JSON.parse(b)
  const enc = String(new Headers(init.headers).get('content-encoding') || '').toLowerCase()
  const buf = Buffer.from(b instanceof Uint8Array ? b : await new Response(b).arrayBuffer())
  const zlib = await import('node:zlib')
  const raw = enc === 'gzip' ? zlib.gunzipSync(buf) : enc === 'deflate' ? zlib.inflateSync(buf)
    : enc === 'br' ? zlib.brotliDecompressSync(buf) : enc === 'zstd' ? zlib.zstdDecompressSync(buf) : buf
  return JSON.parse(raw.toString('utf8'))
}
globalThis.fetch = async (url, init) => {
  const body = await bodyJson(init)
  sent.push({ url: String(url), body, encoding: new Headers(init.headers).get('content-encoding') })
  const r = reply(body)
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
}

const { toSdkQuestions, askJev } = await import('../src/services/jev/client.js')
const { decideAgencyActions } = await import('../src/services/jev/agencyManager.js')

test('old Choice/options and Noul questions become SDK questions', () => {
  const q = toSdkQuestions({
    a: { type: 'Choice', options: ['x', 'y'], instructions: 'pick' },
    b: { type: 'Choice', instructions: 'which', criteria: { one: 'first', two: 'second' } },
    c: { type: 'Noul', instructions: 'yes?' },
  })
  assert.deepEqual(q.a, { type: 'choice', instructions: 'pick', criteria: { x: null, y: null } })
  assert.deepEqual(q.b.criteria, { one: 'first', two: 'second' })
  assert.deepEqual(q.c, { type: 'noul', instructions: 'yes?' })
})

test('agency manager: one choice per profile, answers become decisions', async () => {
  reply = (body) => ({
    status: 200,
    body: {
      model: 'jev-test',
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, {
        type: 'choice', choice: i === 0 ? 'make_cv' : 'wait', confidence: 0.9,
        probabilities: { make_cv: i === 0 ? 0.9 : 0.05, submit_police_certificate: 0.02, send_message: 0.03, wait: i === 0 ? 0.05 : 0.9 },
      }])),
    },
  })
  const res = await decideAgencyActions([
    { id: 1, full_name: 'A', files_present: ['Photo'], last_status: 'never' },
    { id: 2, full_name: 'B', files_present: [], last_status: 'done' },
  ])
  const last = sent.at(-1)
  assert.match(last.url, /\/v1\/systemone$/)
  assert.deepEqual(Object.keys(last.body.questions), ['p_1', 'p_2'])
  assert.equal(last.body.questions.p_1.type, 'choice')
  assert.equal(res.source, 'jev')
  assert.deepEqual(res.decisions.map(d => [d.profileId, d.next_action]), [[1, 'make_cv'], [2, 'wait']])
})

test('402 (no credits): falls back, then pauses instead of calling on every step', async () => {
  reply = () => ({ status: 402, body: { error: { message: 'no available TypeSafe API credits' } } })
  const before = sent.length
  const r1 = await askJev({ s: 1 }, { q: { type: 'Noul', instructions: 'ok?' } })
  assert.equal(r1.ok, false)
  const calls = sent.length - before
  const r2 = await askJev({ s: 2 }, { q: { type: 'Noul', instructions: 'ok?' } })
  assert.equal(r2.reason, 'paused')
  assert.equal(sent.length - before, calls, 'no request while paused')
})
