/**
 * A mock Musaned (tawtheeq.musaned.com.sa + accounts.wahid.sa) and a mock
 * "I'm not a robot" (www.google.com/recaptcha/api2/anchor, another site, in a
 * frame), served over HTTPS on one local port. The test browser maps those
 * names here (--host-resolver-rules), so the real code runs on its real URLs.
 *
 * The robot check is ticked only by a real click in its frame (the test plays
 * the person). The sign-in POST is refused without its token; the code page
 * takes only the account's current TOTP code.
 */
import https from 'https'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { totp } from '../../src/services/musanedTotp.js'

export function selfSigned(dir) {
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=mock'], { stdio: 'ignore' })
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
}

const page = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => c.split('=').map(decodeURIComponent)))
const form = (req) => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(Object.fromEntries(new URLSearchParams(b)))) })

// chosen: the rows Musaned's Employment Requests list answers (its data address, api-tawtheeq), [] = nobody chosen.
// loginTtlMs: a sign-in form older than this answers like wahid.sa's Keycloak: "Your login attempt timed out…".
export async function startMockPortal({ accounts, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-mock-')), chosen = [], loginTtlMs = 0 }) {
  const events = []   // what happened, in order: { what, user, at }
  const note = (what, extra = {}) => events.push({ what, at: Date.now(), ...extra })
  const pending = new Map()   // otp ticket → username
  const server = https.createServer(selfSigned(dir), async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0]
    const url = new URL(req.url, `https://${host}`)
    const send = (html, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(html) }
    const go = (to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end() }

    if (host === 'www.google.com' && url.pathname === '/recaptcha/api2/anchor') {
      // The checkbox: a person's click ticks it and hands the token to the page.
      return send(page('reCAPTCHA', `<div id="recaptcha-anchor" role="checkbox" aria-checked="false" style="width:28px;height:28px;border:2px solid #888;cursor:pointer"></div><span>I'm not a robot</span>
<script>
const a = document.getElementById('recaptcha-anchor')
a.addEventListener('click', (e) => {
  if (!e.isTrusted) return
  a.setAttribute('aria-checked', 'true'); a.style.background = '#0a0'
  parent.postMessage({ mockToken: 'tok-' + 'x'.repeat(40) }, '*')
})
</script>`))
    }

    if (host === 'accounts.wahid.sa') {
      if ((url.pathname === '/login' || url.pathname === '/auth/realms/wahid/protocol/openid-connect/auth') && req.method === 'GET') {   // (wahid.sa's own address too)
        return send(page('Sign in', `<form method="post" action="/login"><input type="hidden" name="started" value="${Date.now()}">
${url.searchParams.get('expired') ? '<span id="input-error" class="kc-feedback-text">Your login attempt timed out. Login will start from the beginning.</span>' : ''}
<input id="username" name="username"><input id="password" name="password" type="password">
<div class="g-recaptcha"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=mock" width="300" height="80"></iframe>
<textarea name="g-recaptcha-response" style="display:none"></textarea></div>
<button id="kc-login" type="submit">Sign In</button>${url.searchParams.get('err') ? `<p class="err">${url.searchParams.get('err')}</p>` : ''}</form>
<script>addEventListener('message', (e) => { if (e.data?.mockToken) document.querySelector('textarea[name="g-recaptcha-response"]').value = e.data.mockToken })</script>`))
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const f = await form(req)
        if (loginTtlMs && Date.now() - Number(f.started || 0) > loginTtlMs) { note('login-expired', { user: f.username }); return go('/login?expired=1') }
        const acct = accounts.find(a => a.username === f.username && a.password === f.password)
        const ticked = /^tok-x{40}$/.test(f['g-recaptcha-response'] || '')
        note('login-post', { user: f.username, ticked, ok: !!acct && ticked })
        if (!ticked) return go('/login?err=Tick+the+box')
        if (!acct) return go('/login?err=Invalid+username+or+password')
        const t = Math.random().toString(36).slice(2)
        pending.set(t, acct)
        return go(`/otp?t=${t}`)
      }
      if (url.pathname === '/otp' && req.method === 'GET') {
        return send(page('Code', `<form method="post" action="/otp?t=${url.searchParams.get('t')}"><label>Verification code</label>
<input name="otp" autocomplete="one-time-code"><button type="submit">Sign In</button>${url.searchParams.get('err') ? '<p>Wrong code</p>' : ''}</form>`))
      }
      if (url.pathname === '/otp' && req.method === 'POST') {
        const f = await form(req)
        const acct = pending.get(url.searchParams.get('t'))
        const now = Date.now()
        const ok = !!acct && [now - 30000, now, now + 30000].some(at => totp({ secret: acct.secret }, at) === f.otp)
        note('otp-post', { user: acct?.username, ok })
        if (!ok) return go(`/otp?t=${url.searchParams.get('t')}&err=1`)
        return go(`https://tawtheeq.musaned.com.sa/sso?u=${encodeURIComponent(acct.username)}`)
      }
    }

    // Musaned's data address: the Employment Requests list (the page's own sign-in headers; CORS like Musaned).
    if (host === 'api-tawtheeq.musaned.com.sa') {
      const cors = { 'access-control-allow-origin': 'https://tawtheeq.musaned.com.sa', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization, app-organization, accept-language, content-type' }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
      if (url.pathname === '/api/search/employment') {
        const ok = /^Bearer /.test(String(req.headers.authorization || '')) && req.headers['app-organization']
        note('list', { ok: !!ok, page: url.searchParams.get('page') })
        res.writeHead(ok ? 200 : 401, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify(ok ? { content: Number(url.searchParams.get('page')) ? [] : chosen } : { error: 'unauthorized' }))
      }
      res.writeHead(404, cors); return res.end()
    }
    if (host === 'tawtheeq.musaned.com.sa') {
      if (url.pathname.startsWith('/employment-requests') && cookies(req).sess) {
        const who = cookies(req).sess
        return send(page('Musaned - Employment Requests', `<h2>Employment Requests</h2><div id="rows">…</div>
<script>fetch('https://api-tawtheeq.musaned.com.sa/api/search/employment?sort=createdAt,DESC&page=0&size=10', { headers: { authorization: 'Bearer ' + ${JSON.stringify('t-')} + ${JSON.stringify(who)}, 'app-organization': '7' } })
  .then(r => r.json()).then(j => { document.getElementById('rows').textContent = (j.content || []).length + ' requests' })</script>`))
      }
      if (url.pathname === '/sso') {
        note('signed-in', { user: url.searchParams.get('u') })
        return go('/dashboard', { 'set-cookie': `sess=${encodeURIComponent(url.searchParams.get('u'))}; Path=/; Secure; HttpOnly` })
      }
      const who = cookies(req).sess
      if (!who) return send(page('Musaned', '<h1>Musaned</h1><p>Welcome to the platform for domestic labour.</p><a href="https://accounts.wahid.sa/login">Login</a>'))
      const acct = accounts.find(a => a.username === who)
      return send(page('Musaned - Dashboard', `<nav><a href="/dashboard">Dashboard</a> <a href="/organizations">Organizations</a> <a href="/hr-pool">HR Pool</a> <a href="/employment-requests">Employment Requests</a></nav>
<div class="dropdown" style="position:fixed;top:10px;right:20px"><button class="dropdown-toggle" style="width:40px;height:40px" onclick="document.getElementById('m').style.display='block'">☰</button>
<div id="m" class="dropdown-menu" style="display:none"><div class="dropdown-item fw-bold">${acct?.name || who}</div><a class="dropdown-item" href="/logout">Logout</a></div></div>
<h2>Latest Requests</h2><p>${'Lorem ipsum dolor sit amet. '.repeat(6)}</p>`))
    }
    send('not found', 404)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { port, events, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) }
}
