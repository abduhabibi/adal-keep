/*
 * Adal Keep phone app — the start screen (connect.html; the app itself is the
 * same Adal Keep pages, built in: index.html).
 *   1. First time: the person types the PC's 5-digit number. The phone asks
 *      the office Wi-Fi "where is Adal Keep?" (UDP, the same question Adal
 *      Keep PCs ask), and the PC with that number answers with its addresses.
 *   2. Every time after: the app opens that PC — on the office Wi-Fi by its
 *      Wi-Fi address, from anywhere else by its Tailscale address.
 * Everything else (profiles, runs, files) is the PC's own Adal Keep page.
 */
const KEY = 'adal-pc'
const $ = (id) => document.getElementById(id)
const show = (id) => ['pair', 'wait', 'fail'].forEach(s => $(s).classList.toggle('hidden', s !== id))
const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } }

async function getJSON(url, opts = {}, ms = 3000) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(url, { ...opts, signal: c.signal, headers: { 'Content-Type': 'application/json' } })
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok, status: r.status, body }
  } catch { return { ok: false, status: 0, body: {} } } finally { clearTimeout(t) }
}

/** Adal Keep PCs on this Wi-Fi: [{url, name}] (native UDP broadcast). */
async function discover() {
  const plugin = window.Capacitor?.Plugins?.AdalDiscovery
  if (!plugin) return []
  try { return (await plugin.find({ timeoutMs: 2500 })).servers || [] } catch { return [] }
}

/** Find the PC with this number on the Wi-Fi; returns its info or null. */
async function pairOnWifi(number) {
  const servers = await discover()
  for (const s of servers) {
    const old = saved()
    const device = old?.cloud ? null : `Phone ${new Date().toLocaleDateString('en-GB')}`
    const r = await getJSON(`${s.url}/api/mobile/pair`, { method: 'POST', body: JSON.stringify({ number, device }) }, 15000)
    if (r.ok && r.body.ok) {
      // r.body.cloud: this phone's own online account — the app works from the
      // agency's online copy when the PC cannot be reached.
      const pc = { number, name: r.body.name, lan: [s.url, ...(r.body.lan || [])].filter((v, i, a) => a.indexOf(v) === i), tailscale: r.body.tailscale || null,
        cloud: r.body.cloud || (old?.number === number ? old.cloud : null) || null }
      localStorage.setItem(KEY, JSON.stringify(pc))
      return { pc }
    }
    if (r.status === 403 || r.status === 429) return { error: r.body.error || 'Wrong number.' }
  }
  return { error: servers.length ? 'No Adal Keep PC with that number on this Wi-Fi.' : 'No Adal Keep PC found on this Wi-Fi. Connect the phone to the office Wi-Fi (the same one as the PC).' }
}

async function open(pc) {
  show('wait')
  $('waitMsg').textContent = `${pc.name || 'Adal Keep'} · connecting…`
  const tryUrls = async (urls) => {
    for (const u of urls.filter(Boolean)) if ((await getJSON(`${u}/api/mobile/ping`, {}, 2500)).ok) return u
    return null
  }
  // Office Wi-Fi first, then Tailscale (anywhere), then look again on the
  // Wi-Fi (the PC's Wi-Fi address may have changed).
  let url = await tryUrls(pc.lan || []) || await tryUrls([pc.tailscale])
  if (!url) {
    const again = await pairOnWifi(pc.number)
    if (again.pc) url = await tryUrls([...(again.pc.lan || []), again.pc.tailscale])
  }
  if (url) { await updateFrom(url); location.href = `${url}/`; return }
  // The PC is off or far away: the built-in Adal Keep on the online copy.
  if (pc.cloud) { location.replace('/?cloud=1'); return }
  show('fail')
  $('failMsg').innerHTML = `Cannot reach <b>${pc.name || 'the PC'}</b>.<br><br>In the office: connect to the office Wi-Fi.<br>Away: open the Tailscale app and turn it on.<br>The PC must be on.`
}

/**
 * The PC hands out the newest Adal Keep app (it updates itself from GitHub).
 * A newer one is downloaded and Android's installer opens ("Update?").
 * Asked again at most every 6 hours if the person said no.
 */
async function updateFrom(base) {
  const plugin = window.Capacitor?.Plugins?.AdalDiscovery
  if (!plugin?.getVersion) return
  try {
    const last = Number(localStorage.getItem('adal-update-asked') || 0)
    const mine = await plugin.getVersion()
    const r = await getJSON(`${base}/api/mobile/app`, {}, 4000)
    if (!r.ok || !(r.body.versionCode > mine.versionCode)) return
    if (Date.now() - last < 6 * 3600 * 1000) return
    localStorage.setItem('adal-update-asked', String(Date.now()))
    $('waitMsg').textContent = `Updating Adal Keep to ${r.body.versionName || 'the new version'}…`
    const res = await plugin.installUpdate({ url: `${base}/api/mobile/app.apk` })
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
  const value = () => boxes.map(b => b.value).join('')
  boxes.forEach((b, i) => {
    b.value = ''
    b.oninput = () => {
      b.value = b.value.replace(/\D/g, '').slice(-1)
      if (b.value && boxes[i + 1]) boxes[i + 1].focus()
      $('go').disabled = value().length !== 5
      if (value().length === 5) $('go').click()
    }
    b.onkeydown = (e) => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus() }
  })
  boxes[0].focus()
  $('go').disabled = true
  $('go').onclick = async () => {
    const number = value()
    if (number.length !== 5) return
    $('go').disabled = true
    $('pairMsg').className = 'msg'
    $('pairMsg').textContent = 'Looking for the PC on this Wi-Fi…'
    const r = await pairOnWifi(number)
    if (r.pc) return open(r.pc)
    startPair(r.error)
  }
}

$('retry').onclick = () => { const pc = saved(); pc ? open(pc) : startPair() }
$('repair').onclick = () => startPair()
// "Try the PC again" from the app: straight back to connecting.

const pc = saved()
if (pc && !new URLSearchParams(location.search).has('pair')) open(pc)
else startPair()
