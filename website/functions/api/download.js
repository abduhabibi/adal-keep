// Cloudflare Pages Function: GET /api/download?arch=x64|x86&code=XXXX[&as=file]
// Gives a fresh short-lived (15 min) signed link from the PRIVATE Supabase bucket "adal-install".
// The installer holds the licence key, so a download needs a code made in Adal Keep Admin → Setup
// (table install_codes). Set DOWNLOAD_OPEN=1 in the Pages settings to turn the code off.
// Secrets (Pages → Settings → Variables and Secrets): SUPABASE_URL, SUPABASE_SERVICE_KEY.
const BUCKET = 'adal-install'
const FILES = { x64: 'site/install-x64.ps1', x86: 'site/install-x86.ps1' }
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url)
  const arch = u.searchParams.get('arch') === 'x86' ? 'x86' : 'x64'
  const code = String(u.searchParams.get('code') || '').trim().toUpperCase()
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return json({ error: 'Downloads are not set up yet.' }, 503)
  const h = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' }

  if (env.DOWNLOAD_OPEN !== '1') {
    if (!/^[0-9A-F]{10}$/.test(code)) return json({ error: 'Type the download code Adal Keep gave you.' }, 401)
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/install_codes?code=eq.${code}&select=code,uses,max_uses,expires_at`, { headers: h })
    const row = (await r.json().catch(() => []))?.[0]
    if (!row || new Date(row.expires_at) < new Date()) return json({ error: 'That code is wrong or has expired. Ask Adal Keep for a new one.' }, 401)
    if (row.uses >= row.max_uses) return json({ error: 'That code was used up. Ask Adal Keep for a new one.' }, 401)
  }

  const sign = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${FILES[arch]}`, { method: 'POST', headers: h, body: JSON.stringify({ expiresIn: 900 }) })
  if (!sign.ok) return json({ error: arch === 'x86' ? 'The 32-bit installer is not ready yet. Use a 64-bit PC, or call Adal Keep.' : 'The installer is not published yet. Call Adal Keep.' }, 404)
  const { signedURL } = await sign.json()
  const link = `${env.SUPABASE_URL}/storage/v1${signedURL.startsWith('/') ? '' : '/'}${signedURL}`
  if (env.DOWNLOAD_OPEN !== '1') {
    // Counted only when a link is handed out. (Read-then-write: two at the same instant may count once; the code is still short-lived.)
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/install_codes?code=eq.${code}&select=uses`, { headers: h })
    const uses = ((await r.json().catch(() => []))?.[0]?.uses ?? 0) + 1
    await fetch(`${env.SUPABASE_URL}/rest/v1/install_codes?code=eq.${code}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ uses }) })
  }
  // Written backwards: a long secret-looking link is cut when copied from chats.
  const back = [...link].reverse().join('')
  const command = `$u='${back}'; $c=$u.ToCharArray(); [array]::Reverse($c); irm (-join $c) | iex`
  if (u.searchParams.get('as') === 'file') {
    // A file to double-click: starts PowerShell with the same line.
    const cmd = `@echo off\r\ntitle Install Adal Keep\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"\r\npause\r\n`
    return new Response(cmd, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="Install Adal Keep (${arch === 'x86' ? '32' : '64'}-bit).cmd"`, 'Cache-Control': 'no-store' } })
  }
  return json({ command, minutes: 15 })
}
