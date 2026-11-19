import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import http from 'http'

test('a new "needs you" wakes every phone through Firebase once; a gone token is dropped', async () => {
  const { default: knex } = await import('knex')
  const f = await import('../src/services/fcmPush.js')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('settings', t => { t.string('key').primary(); t.text('value') })
  // A fake Google: the sign-in checks the signed JWT, the send answers per token.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sends = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      if (req.url === '/token') {
        const jwt = new URLSearchParams(body).get('assertion').split('.')
        const ok = crypto.createVerify('RSA-SHA256').update(`${jwt[0]}.${jwt[1]}`).verify(publicKey, Buffer.from(jwt[2], 'base64url'))
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(ok ? { access_token: 'ya29.test', expires_in: 3600 } : { error: 'bad' }))
      }
      const m = JSON.parse(body).message
      sends.push({ url: req.url, auth: req.headers.authorization, m })
      if (m.token.startsWith('gone')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })) }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  f._testSetUp({ account: { project_id: 'adal-keep-test', client_email: 'x@adal-keep-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token` }, token: `${base}/token`, fcm: base })
  f._testReset()
  try {
    await f.savePushToken(db, 'phone-one-token-1234567890:abc')
    await f.savePushToken(db, 'gone-token-123456789012345:xyz')
    await assert.rejects(() => f.savePushToken(db, 'bad token'))
    const call = { run_id: 7, title: 'Sign in to Musaned', at: 1000, profile_id: 3 }
    // The first list after a start: old calls, nothing sent.
    assert.equal((await f.attentionOnline(db, [call])).sent, 0)
    assert.equal(sends.length, 0)
    // A new call: one push to each phone, a data message at high priority.
    const r = await f.attentionOnline(db, [call, { ...call, run_id: 8, at: 2000 }])
    assert.equal(r.sent, 1)
    assert.equal(r.gone, 1)
    assert.equal(sends.length, 2)
    assert.equal(sends[0].url, '/v1/projects/adal-keep-test/messages:send')
    assert.equal(sends[0].auth, 'Bearer ya29.test')
    assert.deepEqual(sends[0].m.data, { type: 'attention' })
    assert.equal(sends[0].m.android.priority, 'HIGH')
    // The same list again, or a call gone: nothing.
    assert.equal((await f.attentionOnline(db, [call])).sent, 0)
    assert.equal(sends.length, 2)
    // A call still waiting for the phone's turn (phone_wait_ms): no push yet.
    assert.equal((await f.attentionOnline(db, [call, { run_id: 9, title: 'Code', at: 3, phone_wait_ms: 5000 }])).sent, 0)
    // The gone token was dropped.
    const kept = JSON.parse((await db('settings').where({ key: 'fcm_tokens' }).first()).value)
    assert.deepEqual(Object.keys(kept), ['phone-one-token-1234567890:abc'])
  } finally {
    server.close()
    await db.destroy()
  }
})
