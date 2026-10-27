/*
 * Adal Keep phone app — the start screen (connect.html). The app itself is
 * the same Adal Keep pages, built in (index.html), working through Supabase
 * only: the agency's online copy, and its PC live while that PC is on.
 *
 * Pairing, from anywhere: the PC's 5-digit number + the agency's phone
 * password (set on the main PC: Settings → Main PC). The phone makes its own
 * online account and joins the agency (Supabase keep_join) — the PC does not
 * need to be on, and no Wi-Fi is shared.
 * config.js (written when the app is built) gives the Supabase address.
 */
const KEY = 'adal-pc'
const CFG = window.ADAL_CLOUD_CONFIG || {}
const $ = (id) => document.getElementById(id)
const show = (id) => ['pair', 'wait'].forEach(s => $(s).classList.toggle('hidden', s !== id))
const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } }

async function sb(path, { method = 'POST', body, token } = {}) {
  const r = await fetch(`${CFG.url}${path}`, {
    method,
    headers: { apikey: CFG.anon, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await r.text()
  let j = null; try { j = t ? JSON.parse(t) : null } catch { j = t }
  if (!r.ok) throw new Error(j?.message || j?.msg || j?.error_description || `Error ${r.status}`)
  return j
}
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('')

async function pair(number, password, name) {
  // This phone's own online account …
  const creds = { email: `phone-${rand(5)}@agency.adalkeep.app`, password: rand(24) }
  let s = await sb('/auth/v1/signup', { body: creds })
  if (!s?.access_token) s = await sb('/auth/v1/token?grant_type=password', { body: creds })
  // … which the agency's password lets into the agency.
  const agency = await sb('/rest/v1/rpc/keep_join', { body: { p_pc: number, p_password: password, p_name: name }, token: s.access_token })
  const pc = { number, name: name || null, cloud: { url: CFG.url, anon: CFG.anon, email: creds.email, password: creds.password, agency, device: s.user?.id || null } }
  localStorage.setItem(KEY, JSON.stringify(pc))
  return pc
}

function open() {
  show('wait')
  $('waitMsg').textContent = 'Opening Adal Keep…'
  location.replace('/?cloud=1')
}

/** The newest app is published with Adal Keep itself (GitHub); Android asks "Update?". */
async function checkUpdate() {
  const plugin = window.Capacitor?.Plugins?.AdalDiscovery
  if (!plugin?.getVersion || !CFG.updates) return
  try {
    if (Date.now() - Number(localStorage.getItem('adal-update-asked') || 0) < 6 * 3600 * 1000) return
    const mine = await plugin.getVersion()
    const v = await (await fetch(`${CFG.updates}/version.json`, { cache: 'no-store' })).json()
    if (!(v.versionCode > mine.versionCode)) return
    localStorage.setItem('adal-update-asked', String(Date.now()))
    show('wait')
    $('waitMsg').textContent = `Updating Adal Keep to ${v.versionName || 'the new version'}…`
    const res = await plugin.installUpdate({ url: `${CFG.updates}/AdalKeep.apk` })
    if (res?.needsPermission) {
      $('waitMsg').textContent = 'Allow "Install unknown apps" for Adal Keep, then come back — the update installs next time.'
      localStorage.removeItem('adal-update-asked')
      await new Promise(r => setTimeout(r, 6000))
    } else await new Promise(r => setTimeout(r, 1500))
  } catch {}
}

function startPair(msg = '') {
  show('pair')
  $('pairMsg').textContent = msg
  $('pairMsg').className = 'msg' + (msg ? ' bad' : '')
  const boxes = [...$('digits').querySelectorAll('input')]
  const number = () => boxes.map(b => b.value).join('')
  const ready = () => { $('go').disabled = number().length !== 5 || $('pw').value.length < 6 }
  boxes.forEach((b, i) => {
    b.oninput = () => {
      b.value = b.value.replace(/\D/g, '').slice(-1)
      if (b.value && boxes[i + 1]) boxes[i + 1].focus()
      else if (b.value && i === boxes.length - 1) $('pw').focus()
      ready()
    }
    b.onkeydown = (e) => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus() }
  })
  $('pw').oninput = ready
  $('pw').onkeydown = (e) => { if (e.key === 'Enter' && !$('go').disabled) $('go').click() }
  if (!number()) boxes[0].focus()
  ready()
  $('go').onclick = async () => {
    if (!CFG.url) return startPair('This app was built without the online address — ask Adal for a new app.')
    $('go').disabled = true
    $('pairMsg').className = 'msg'
    $('pairMsg').textContent = 'Joining the agency…'
    try { await pair(number(), $('pw').value, $('who').value.trim()); open() }
    catch (e) { startPair(/fetch|network/i.test(e.message) ? 'No internet — connect the phone to the internet and try again.' : e.message) }
  }
}

;(async () => {
  await checkUpdate()
  const pc = saved()
  if (pc?.cloud && !new URLSearchParams(location.search).has('pair')) open()
  else startPair()
})()
