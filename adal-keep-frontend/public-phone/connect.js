/*
 * Adal Keep phone app — the start screen (connect.html). The app itself is
 * the same Adal Keep pages, built in (index.html), working through Supabase
 * only: the agency's online copy, and its PC live while that PC is on.
 *
 * Pairing, from anywhere: the PC's 5-digit number only. The phone makes its
 * own online account and asks to join (Supabase keep_request_join); the PC
 * shows "… wants to join — Yes, it's me / No"; after Yes the phone goes on by
 * itself. No Wi-Fi is shared.
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

const phoneName = () => {
  const ua = navigator.userAgent || ''
  const model = (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/) || [])[1]
  return (model ? model.trim() : 'Phone') + ' · ' + new Date().toLocaleDateString('en-GB')
}

async function pair(number) {
  // This phone's own online account …
  const creds = { email: `phone-${rand(5)}@agency.adalkeep.app`, password: rand(24) }
  let s = await sb('/auth/v1/signup', { body: creds })
  if (!s?.access_token) s = await sb('/auth/v1/token?grant_type=password', { body: creds })
  // … asks to join; the PC answers.
  const id = await sb('/rest/v1/rpc/keep_request_join', { body: { p_pc: number, p_name: phoneName() }, token: s.access_token })
  show('wait')
  $('waitMsg').innerHTML = 'On the office PC, press <b>“Yes, it\'s me”</b>.<br><span style="font-size:12px">Waiting for the PC…</span>'
  for (let i = 0; i < 300; i++) {          // up to 10 minutes
    await new Promise(r => setTimeout(r, 2000))
    const [q] = await sb(`/rest/v1/keep_join_requests?id=eq.${id}&select=status,agency_id`, { method: 'GET', token: s.access_token }).catch(() => [])
    if (q?.status === 'approved') {
      const pc = { number, cloud: { url: CFG.url, anon: CFG.anon, email: creds.email, password: creds.password, agency: q.agency_id, device: s.user?.id || null } }
      localStorage.setItem(KEY, JSON.stringify(pc))
      return pc
    }
    if (q?.status === 'denied') throw new Error('The PC said No.')
  }
  throw new Error('Nobody answered on the PC. Try again when someone is at the office PC.')
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
  const ready = () => { $('go').disabled = number().length !== 5 }
  boxes.forEach((b, i) => {
    b.oninput = () => {
      b.value = b.value.replace(/\D/g, '').slice(-1)
      if (b.value && boxes[i + 1]) boxes[i + 1].focus()
      ready()
      if (number().length === 5) $('go').click()   // the 5th digit opens
    }
    b.onkeydown = (e) => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus() }
  })
  if (!number()) boxes[0].focus()
  ready()
  $('go').onclick = async () => {
    if (!CFG.url) return startPair('This app was built without the online address — ask Adal for a new app.')
    $('go').disabled = true
    $('pairMsg').className = 'msg'
    $('pairMsg').textContent = 'Asking the PC…'
    try { await pair(number()); open() }
    catch (e) {
      boxes.forEach(b => { b.value = '' })
      startPair(/fetch|network/i.test(e.message) ? 'No internet — connect the phone to the internet and try again.' : e.message)
    }
  }
}

;(async () => {
  await checkUpdate()
  const pc = saved()
  if (pc?.cloud && !new URLSearchParams(location.search).has('pair')) open()
  else startPair()
})()
