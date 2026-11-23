import test from 'node:test'
import assert from 'node:assert/strict'

const { onRequestGet } = await import('../../website/functions/api/download.js')
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'svc' }
const ask = (qs, e = env) => onRequestGet({ request: new Request(`https://adalkeep.pages.dev/api/download?${qs}`), env: e })

function fakeSupabase({ code = { code: 'ABCDEF0123', uses: 0, max_uses: 3, expires_at: new Date(Date.now() + 86400000).toISOString() }, files = ['site/install-x64.ps1'] } = {}) {
  const log = []
  globalThis.fetch = async (url, o = {}) => {
    log.push([o.method || 'GET', String(url)])
    const u = String(url)
    if (u.includes('/rest/v1/install_codes') && (o.method || 'GET') === 'GET') return new Response(JSON.stringify(code && u.includes(code.code) ? [code] : []))
    if (u.includes('/rest/v1/install_codes') && o.method === 'PATCH') { code.uses = JSON.parse(o.body).uses; return new Response(null, { status: 204 }) }
    if (u.includes('/storage/v1/object/sign/adal-install/')) {
      const f = u.split('adal-install/')[1]
      return files.includes(f) ? new Response(JSON.stringify({ signedURL: `/object/sign/adal-install/${f}?token=t` })) : new Response('{}', { status: 400 })
    }
    throw new Error('unexpected ' + u)
  }
  return { log, code }
}

test('no code, a wrong code and an expired code get nothing', async () => {
  fakeSupabase()
  assert.equal((await ask('arch=x64')).status, 401)
  assert.equal((await ask('arch=x64&code=0000000000')).status, 401)
  fakeSupabase({ code: { code: 'ABCDEF0123', uses: 0, max_uses: 3, expires_at: new Date(Date.now() - 1000).toISOString() } })
  assert.equal((await ask('arch=x64&code=ABCDEF0123')).status, 401)
})

test('a good code gives a backwards signed link and counts one use; used-up codes stop', async () => {
  const { code } = fakeSupabase()
  const r = await ask('arch=x64&code=abcdef0123')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.match(j.command, /irm/)
  const back = j.command.match(/\$u='([^']+)'/)[1]
  assert.match([...back].reverse().join(''), /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/adal-install\/site\/install-x64\.ps1\?token=t$/)
  assert.equal(code.uses, 1)
  code.uses = 3
  assert.equal((await ask('arch=x64&code=ABCDEF0123')).status, 401)
})

test('32-bit says plainly when it is not published; the .cmd file runs the same line', async () => {
  const { code } = fakeSupabase()
  const r = await ask('arch=x86&code=ABCDEF0123')
  assert.equal(r.status, 404)
  assert.match((await r.json()).error, /32-bit/)
  assert.equal(code.uses, 0, 'a refused download is not counted')
  fakeSupabase()
  const f = await ask('arch=x64&code=ABCDEF0123&as=file')
  assert.match(f.headers.get('Content-Disposition'), /Install Adal Keep \(64-bit\)\.cmd/)
  assert.match(await f.text(), /powershell/)
})

test('DOWNLOAD_OPEN=1 needs no code; missing secrets say not set up', async () => {
  fakeSupabase()
  assert.equal((await ask('arch=x64', { ...env, DOWNLOAD_OPEN: '1' })).status, 200)
  assert.equal((await ask('arch=x64', {})).status, 503)
})
