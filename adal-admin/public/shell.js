/*
 * Adal Keep Admin — the frame around the tabs of index.html:
 *   - the left nav in groups, each with its sub-tabs (the old tabs live on inside them)
 *   - addresses (#/overview, #/agency/123456, #/pc/<id>, #/releases …): Back works, a link can be kept
 *   - Overview: "is everything OK?" at a glance, everything clickable
 *   - one agency's whole page (PCs, staff, licence + payments, setup, tickets, robots, version, actions)
 *   - Robots and Releases pages
 *   - global search (Ctrl K or /), keyboard shortcuts (?), light / dark / system theme
 *   - live: /api/live says when Supabase changed, the page looks again at once (no reload)
 * Uses the helpers of index.html (api, ask, tell, toast, esc, ago, when, switchTab …).
 */
(() => {
const ICON = (id, cls = 'ico') => `<svg class="${cls}"><use href="#${id}"/></svg>`
const NAV = [
  { g: 'Run the business' },
  { key: 'overview', label: 'Overview', icon: 'i-home', k: 'o' },
  { key: 'work', label: 'Work', icon: 'i-tasks', k: 'w' },
  { key: 'agencies', label: 'Agencies', icon: 'i-building', k: 'a' },
  { key: 'fleet', label: 'PCs / Fleet', icon: 'i-monitor', k: 'p', subs: [['fleet', 'Fleet'], ['health', 'Health']] },
  { key: 'robots', label: 'Robots', icon: 'i-robot', k: 'r' },
  { key: 'tickets', label: 'Tickets', icon: 'i-inbox', k: 't' },
  { g: 'Money' },
  { key: 'billing', label: 'Billing', icon: 'i-card', k: 'b', subs: [['billing', 'Renewals & payments'], ['payments', 'Receipts'], ['plans', 'Plans'], ['business', 'Business']] },
  { g: 'Ship' },
  { key: 'releases', label: 'Releases', icon: 'i-rocket', k: 'u' },
  { g: 'Talk' },
  { key: 'inbox', label: 'Messages', icon: 'i-chat', k: 'm', subs: [['inbox', 'Inbox'], ['chats', 'All chats']] },
  { g: 'Set up' },
  { key: 'setup', label: 'Settings', icon: 'i-settings', k: 's', subs: [['setup', 'Agency setup'], ['cvt', 'CV templates'], ['agents', 'Agents'], ['ceos', 'CEOs'], ['usage', 'Usage']] },
]
const ITEMS = NAV.filter(n => n.key)
const groupOf = (t) => ITEMS.find(n => n.key === t || (n.subs || []).some(([k]) => k === t)) || ITEMS[0]
const OWN = { overview: overviewView, robots: robotsView, releases: releasesView }
const TITLE = { overview: 'Overview', robots: 'Robots', releases: 'Releases' }
const LIGHTWORD = { green: 'All fine', amber: 'Look at it', red: 'Down' }
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('en')
const etb = (n) => n == null ? '—' : `${Number(n).toLocaleString('en')} ETB`
const pct = (n) => n == null ? '—' : `${n}%`
const shortV = (v) => v ? String(v).slice(0, 7) : '—'
let home = null, homeAt = 0, rel = null, robotsDays = 7, biz = {}, moreOf = {}, counts = {}

// ------------------------------------------------------------- the frame --
function frame() {
  const menu = $('#menu')
  menu.querySelector('.brand').innerHTML = `<i>A</i><div><b>Adal Keep Admin</b><small>All agencies, one place</small></div>`
  const nav = document.createElement('nav'); nav.id = 'nav'
  nav.innerHTML = NAV.map(n => n.g ? `<div class="grp">${n.g}</div>`
    : `<a data-nav="${n.key}" href="#/${n.key}" title="${n.label} (g then ${n.k})">${ICON(n.icon)}<span class="l">${n.label}</span><span class="n" data-count="${n.key}" style="display:none"></span><kbd>g ${n.k}</kbd></a>`).join('')
  menu.querySelector('.tabs').after(nav)
  menu.querySelector('.foot').innerHTML = `<span>Only on this PC</span><span style="margin-left:auto"></span><a href="#" id="keysLink" title="Keyboard shortcuts (?)">?</a><a href="/logout">Sign out</a>`
  // Old tab buttons for the new pages (index.html's switchTab clicks them).
  for (const k of Object.keys(OWN)) { const b = document.createElement('button'); b.dataset.tab = k; menu.querySelector('.tabs').append(b); b.onclick = () => go(k) }
  const head = $('main > header')
  head.insertAdjacentHTML('beforeend', `
    <button class="hbtn" id="findBtn" title="Search agencies, PCs, candidates, tickets">${ICON('i-search')}<span>Search everything</span><kbd>Ctrl K</kbd></button>
    <button class="hbtn icon" id="themeBtn" title="Light / dark (t)"></button>`)
  head.after(Object.assign(document.createElement('div'), { id: 'subnav' }))
  $('#findBtn').onclick = () => palette()
  $('#themeBtn').onclick = () => theme(true)
  $('#keysLink').onclick = (e) => { e.preventDefault(); keys() }
  document.body.insertAdjacentHTML('beforeend', `
    <div id="pal"><div class="box"><div class="in">${ICON('i-search')}<input id="palI" placeholder="Agency, PC, candidate (name or passport), ticket…" autocomplete="off" spellcheck="false"></div><div class="res" id="palR"></div>
      <div class="foot2"><span><span class="kbd">↑</span> <span class="kbd">↓</span> choose</span><span><span class="kbd">Enter</span> open</span><span><span class="kbd">Esc</span> close</span></div></div></div>
    <div id="keys"><div class="box"><h3>Keyboard shortcuts</h3><div class="grid">
      <div><span>Search everything</span><span><span class="kbd">Ctrl K</span> or <span class="kbd">/</span></span></div>
      ${ITEMS.map(n => `<div><span>${n.label}</span><span><span class="kbd">g</span> <span class="kbd">${n.k}</span></span></div>`).join('')}
      <div><span>Look again now</span><span class="kbd">r</span></div><div><span>Light / dark</span><span class="kbd">t</span></div>
      <div><span>Next / previous sub-tab</span><span><span class="kbd">]</span> <span class="kbd">[</span></span></div><div><span>Back</span><span class="kbd">Alt ←</span></div>
      <div><span>This list</span><span class="kbd">?</span></div><div><span>Close</span><span class="kbd">Esc</span></div>
    </div></div></div>`)
  $('#keys').onclick = (e) => { if (e.target.id === 'keys') $('#keys').classList.remove('on') }
  $('#pal').onclick = (e) => { if (e.target.id === 'pal') closePal() }
  theme(false)
}

function paintNav() {
  const g = groupOf(tab)
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === g.key))
  document.body.className = document.body.className.replace(/\bt-\S+/g, '').trim() + ` t-${tab}`
  document.body.classList.toggle('chats', tab === 'inbox' || tab === 'chats')
  document.body.classList.toggle('paged', !!(tab === 'agencies' && pageOf))
  const sub = $('#subnav')
  if (g.subs) {
    sub.innerHTML = `<div class="seg">${g.subs.map(([k, l]) => `<button data-sub="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>`
    sub.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => go(b.dataset.sub))
    sub.classList.add('on')
  } else sub.classList.remove('on')
}

function setCount(key, n, level = '') {
  const el = document.querySelector(`[data-count="${key}"]`)
  if (!el) return
  el.style.display = n ? '' : 'none'; el.textContent = n > 99 ? '99+' : n; el.className = `n ${level}`
}
function badges() {
  const unread = (data.conversations || []).filter(c => c.kind === 'admin').reduce((n, c) => n + (c.unread || 0), 0)
  setCount('inbox', unread, 'bad')
  const receipts = (data.requests || []).filter(r => r.status === 'pending').length
  if (home) {
    setCount('tickets', home.tickets.open, 'warn')
    setCount('fleet', home.pcs.red, 'bad')
    setCount('billing', receipts + home.renewals.expired, receipts ? 'warn' : 'bad')
    setCount('releases', (home.release?.stage === 'stopped' ? 1 : 0) + (home.needs || []).filter(n => n.go === 'releases' && n.level === 'red').length, 'bad')
    setCount('overview', (home.needs || []).filter(n => n.level === 'red').length, 'bad')
  } else setCount('billing', receipts, 'warn')
  document.title = `${unread + receipts ? `(${unread + receipts}) ` : ''}Adal Keep Admin`
}

// ------------------------------------------------------------- addresses --
// #/overview · #/agency/123456 · #/pc/<id> · #/tickets/<id> · #/<any tab>
function go(route, { push = true } = {}) {
  const r = String(route || 'overview').replace(/^#?\/?/, '')
  if (push && location.hash !== `#/${r}`) { history.pushState(null, '', `#/${r}`) }
  apply(r)
}
async function apply(r) {
  const [head, ...rest] = r.split('/'); const arg = decodeURIComponent(rest.join('/'))
  closePal()
  if (head === 'agency' && arg) { pageOf = arg; pageData = KEPT('agency:' + arg); setTab('agencies', false); return }
  if (head === 'pc' && arg) { fleetOpenPC = arg; fleetF = { light: '', q: '', version: '' }; setTab('fleet'); return }
  if (head === 'tickets' && arg) {
    const T = await api('/api/tickets').catch(() => [])
    const t = T.find(x => x.id === arg)
    if (t) { ticketOpen = `${t.account}|${t.id}`; ticketF = { status: '', q: '' } }
    setTab('tickets'); return
  }
  if (head === 'agencies') pageOf = null
  setTab(document.querySelector(`.tabs button[data-tab="${head}"]`) ? head : 'overview')
}
// The old tab buttons do the switching (index.html); the frame follows.
function setTab(t, draw = true) {
  const b = document.querySelector(`.tabs button[data-tab="${t}"]`)
  if (OWN[t]) {
    tab = t; open = null
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b))
    $('#thread').style.display = 'none'; $('#compose').style.display = 'none'
    paintNav(); showTable(); renderList()
  } else if (b && draw) { b.click(); paintNav() }
  else { tab = t; paintNav(); showTable() }
  const w = $('#table'); w.classList.remove('fade'); void w.offsetWidth; w.classList.add('fade')
}
window.addEventListener('popstate', () => apply(location.hash.replace(/^#\/?/, '') || 'overview'))
// Links inside the pages: <a data-go="agency/123456">
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-go]')
  if (a && !e.target.closest('button:not([data-go]), select, input, textarea')) { e.preventDefault(); go(a.dataset.go) }
  const n = e.target.closest('#nav a[data-nav]')
  if (n) { e.preventDefault(); go(n.dataset.nav === 'agencies' ? 'agencies' : n.dataset.nav) }
})

// -------------------------------------------------------------- Overview --
async function loadHome() {
  const h = await api('/api/home')
  home = h; homeAt = Date.now(); KEEP('home', h); badges()
  return h
}
async function overviewView() {
  $('#title').textContent = 'Overview'
  if (home) paintOverview(home)
  else $('#table').innerHTML = '<div class="empty">Looking at every agency…</div>'
  try { const h = await loadHome(); if (tab === 'overview') paintOverview(h) }
  catch (e) { if (!home) $('#table').innerHTML = `<div class="empty">${esc(e.message)}</div>` }
}
let shown = ''
function paintOverview(h) {
  const reds = h.needs.filter(n => n.level === 'red').length, ambers = h.needs.length - reds
  const state = reds ? 'bad' : ambers ? 'warn' : 'ok'
  const A = h.agencies, P = h.pcs, R = h.robots, T = h.tickets, N = h.renewals, M = h.revenue, L = h.release
  const pcBar = P.total ? `<div class="bar2"><i class="ok" style="width:${P.green / P.total * 100}%"></i><i class="warn" style="width:${P.amber / P.total * 100}%"></i><i class="bad" style="width:${P.red / P.total * 100}%"></i></div>` : ''
  const STAGE = { test: 'Test agency', pct: `${L?.rollout?.pct ?? 10}% of agencies`, everyone: 'Every PC', stopped: 'Stopped' }
  const tile = (go, icon, label, num, sub, extra = '', light = '') => `<button class="g tile" data-go="${go}">
      <div class="lbl">${ICON(icon)}${label}${light ? `<span class="lt ${light}"></span>` : ''}</div>
      <div class="num-xl">${num}</div><div class="sub">${sub}</div>${extra}</button>`
  const html = `
    <div class="g hero ${state}">
      <div class="big">${ICON(state === 'ok' ? 'i-check' : 'i-alert')}</div>
      <div><h2>${state === 'ok' ? 'Everything is OK' : reds ? `${reds} thing${reds > 1 ? 's' : ''} need${reds > 1 ? '' : 's'} you now` : `${ambers} thing${ambers > 1 ? 's' : ''} to look at`}</h2>
        <p>${A.online} of ${A.total} agencies on · ${P.green} of ${P.total} PCs fine · robots ${pct(R.today.success)} successful today · ${T.open} open ticket${T.open === 1 ? '' : 's'}</p></div>
      <div class="side">Live<br>${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
    </div>
    ${h.errors?.length ? `<div class="g pad" style="margin-bottom:12px;color:var(--bad);font-size:13px">${h.errors.map(esc).join('<br>')}</div>` : ''}
    <div class="tiles">
      ${tile('agencies', 'i-building', 'Agencies', `${A.online}<small> / ${A.total} on</small>`, A.red ? `${A.red} down · ${A.amber} to look at` : A.amber ? `${A.amber} to look at` : 'all fine', '', A.red ? 'red' : A.amber ? 'amber' : 'green')}
      ${tile('fleet', 'i-monitor', 'PCs', `${P.green}<small> / ${P.total} fine</small>`, `${P.amber} amber · ${P.red} red`, pcBar)}
      ${tile('robots', 'i-robot', 'Robots today', pct(R.today.success), `${fmt(R.today.done)} done · ${fmt(R.today.failed)} failed · ${fmt(R.waiting)} waiting`, R.today.done + R.today.failed ? `<div class="bar2"><i class="ok" style="width:${R.today.success}%"></i><i class="bad" style="width:${100 - R.today.success}%"></i></div>` : '', R.today.success == null ? '' : R.today.success >= 85 ? 'green' : R.today.success >= 60 ? 'amber' : 'red')}
      ${tile('tickets', 'i-inbox', 'Open tickets', fmt(T.open), T.oldest ? `oldest ${ago(T.oldest)} ago` : 'nothing waiting', '', T.open ? 'amber' : 'green')}
      ${tile('billing', 'i-calendar', 'Renewals due', fmt(N.count), `${N.expired} ended · ${N.receipts} receipt${N.receipts === 1 ? '' : 's'} to confirm`, '', N.expired ? 'red' : N.count ? 'amber' : 'green')}
      ${tile('business', 'i-chart', 'Revenue this month', etb(M.month), M.error ? esc(M.error) : `price ${etb(M.price)} / 6 months`)}
      ${tile('releases', 'i-rocket', 'Release', L ? esc(L.short) : '—', L ? `${STAGE[L.stage] || L.stage} · ${L.pcs_on_it}/${L.pcs_total} PCs on it` : 'nothing published', L && L.pcs_total ? `<div class="bar2"><i class="tl" style="width:${L.pcs_on_it / L.pcs_total * 100}%"></i></div>` : '', L ? (L.stage === 'stopped' || L.went_back ? 'red' : 'green') : '')}
    </div>
    <div class="cols" style="margin-top:4px">
      <div>
        <div class="sec"><h3>Needs you</h3><span class="muted" style="font-size:12.5px">most urgent first</span></div>
        <div class="g needlist">${h.needs.map(n => `<div class="need" data-go="${esc(n.go)}"><span class="lt ${n.level}"></span><span class="tx">${esc(n.text)}</span>${ICON('i-chevronRight')}</div>`).join('') || '<div class="empty">Nothing. Every agency, PC, robot and payment is fine.</div>'}</div>
        <div class="sec"><h3>Every agency</h3><button class="more" data-go="agencies">All agencies →</button></div>
        <div class="g aglist2">${A.list.map(a => `<div class="r" data-go="agency/${esc(a.pc_number || a.id)}">
          <span class="lt ${a.light}" title="${LIGHTWORD[a.light]}"></span>
          <span class="nm">${esc(a.name)}</span>
          <span class="why">${a.why.length ? esc(a.why.join(' · ')) : `${a.pcs} PC${a.pcs === 1 ? '' : 's'} fine${a.profiles != null ? ` · ${a.profiles} profiles` : ''}`}</span>
          <span class="tg">${a.tickets ? `<span class="tag warn">${a.tickets} ticket${a.tickets > 1 ? 's' : ''}</span>` : ''}${a.waiting ? `<span class="tag">${a.waiting} waiting</span>` : ''}${a.version ? `<span class="tag ${a.current ? 'ok' : ''}" title="${esc(a.version)}">${shortV(a.version)}</span>` : ''}${renewTag(a.renewal)}</span>
        </div>`).join('') || '<div class="empty">No agency yet.</div>'}</div>
      </div>
      <div>
        <div class="sec"><h3>Release</h3><button class="more" data-go="releases">Releases →</button></div>
        <div class="g pad click" data-go="releases">${L ? `<div style="display:flex;gap:8px;align-items:baseline"><b style="font-size:16px">${esc(L.short)}</b><span class="muted" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(L.message || '')}</span></div>
          ${stageTrack(L)}<div class="muted" style="font-size:12.5px">${L.pcs_on_it} of ${L.pcs_total} PCs on it · published ${ago(L.published_at)} ago${L.went_back ? ` · <b style="color:var(--bad)">${L.went_back} went back</b>` : ''}</div>` : '<div class="empty">Nothing published.</div>'}</div>
        <div class="sec"><h3>Robots today</h3><button class="more" data-go="robots">Robots →</button></div>
        <div class="g pad click" data-go="robots">${robotRows(R.today.list) || '<div class="empty">No robot run finished today yet.</div>'}</div>
        <div class="sec"><h3>Renewals</h3><button class="more" data-go="billing">Billing →</button></div>
        <div class="g needlist">${N.due.map(d => `<div class="need" data-go="agency/${esc(d.pc_number)}">${renewTag(d, true)}<span class="tx">${esc(d.name)}</span><span class="muted" style="font-size:12px">${d.ends ? new Date(d.ends).toLocaleDateString('en-GB') : ''}</span></div>`).join('') || '<div class="empty">No renewal in the next 30 days.</div>'}</div>
        <div class="sec"><h3>Open tickets</h3><button class="more" data-go="tickets">Tickets →</button></div>
        <div class="g needlist">${T.latest.map(t => `<div class="need" data-go="tickets/${esc(t.id)}"><span class="lt amber"></span><span class="tx"><b>${esc(t.agency)}</b> · ${esc(t.text)}</span><span class="muted" style="font-size:12px">${ago(t.at)}</span></div>`).join('') || '<div class="empty">No open ticket.</div>'}</div>
      </div>
    </div>`
  if (html === shown && $('#table .hero')) return
  shown = html
  $('#table').innerHTML = html
}
function renewTag(r, always = false) {
  if (!r) return ''
  if (r.state === 'expired') return `<span class="tag bad">ended ${-r.days} d ago</span>`
  if (r.state === 'suspended') return '<span class="tag bad">locked</span>'
  if (r.state === 'trial') return `<span class="tag ${r.days <= 7 ? 'warn' : ''}">trial · ${r.days} d</span>`
  if (r.days <= 30 || always) return `<span class="tag ${r.days <= 7 ? 'warn' : 'ok'}">paid · ${r.days} d</span>`
  return ''
}
function stageTrack(L) {
  const order = ['test', 'pct', 'everyone']
  const at = L.stage === 'stopped' ? -1 : order.indexOf(L.stage)
  const names = ['Test', `${L.rollout?.pct ?? 10}%`, 'All']
  const stopAt = L.stage === 'stopped' ? (Date.parse(L.rollout?.pct_at) < Date.now() ? 1 : 0) : -1
  return `<div class="track">${order.map((s, i) => {
    const c = stopAt === i ? 'stop' : i < at || (i === at && s === 'everyone') ? 'done' : i === at ? 'now' : stopAt > i ? 'done' : ''
    return `${i ? `<span class="ln ${i <= at || i <= stopAt ? 'done' : ''}"></span>` : ''}<span class="st ${c}"><i></i>${names[i]}${stopAt === i ? ' · stopped' : ''}</span>`
  }).join('')}</div>`
}
const robotRows = (list) => (list || []).slice(0, 8).map(r => `<div class="robrow"><span>${esc(wf(r.robot))}</span>
  <div class="bar2"><i class="ok" style="width:${r.success}%"></i><i class="bad" style="width:${100 - r.success}%"></i></div>
  <span class="p" title="${r.done} done, ${r.failed} failed">${r.success}% <span class="muted" style="font-weight:500">${r.done + r.failed}</span></span></div>`).join('')

// ---------------------------------------------------------------- Robots --
async function robotsView() {
  $('#title').textContent = 'Robots — every agency'
  const paint = () => {
    if (tab !== 'robots') return
    const B = biz[robotsDays], h = home
    const ws = (work || []).filter(a => a.summary)
    const waiting = ws.flatMap(a => (a.summary.waiting || []).map(r => ({ ...r, agency: a }))).sort((x, y) => String(y.at).localeCompare(String(x.at)))
    const failed = ws.flatMap(a => (a.summary.failed || []).map(r => ({ ...r, agency: a }))).sort((x, y) => String(y.at).localeCompare(String(x.at)))
    const reasons = {}
    for (const r of failed) { const k = r.reason || 'no reason given'; reasons[k] = (reasons[k] || 0) + 1 }
    const per = ws.map(a => ({ a, run: a.summary.runs || {} })).sort((x, y) => (y.run.failed7d || 0) - (x.run.failed7d || 0))
    $('#table').innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <div class="uctl">${[1, 7, 30].map(d => `<button class="${robotsDays === d ? 'on' : ''}" data-days="${d}">${d === 1 ? 'Today' : `${d} days`}</button>`).join('')}</div>
        <span class="muted" style="font-size:12.5px">From each agency's 30-minute counts; waiting and failed runs from their online copy.</span></div>
      <div class="tiles">
        ${(() => { const s = robotsDays === 1 ? h?.robots.today : { done: (B?.robots || []).reduce((t, r) => t + r.done, 0), failed: (B?.robots || []).reduce((t, r) => t + r.failed, 0) }; if (s && s.success == null && s.done + s.failed) s.success = Math.round(s.done / (s.done + s.failed) * 100); return `
        <div class="g tile"><div class="lbl">${ICON('i-check')}Successful</div><div class="num-xl">${pct(s?.success ?? null)}</div><div class="sub">${fmt(s?.done)} done · ${fmt(s?.failed)} failed</div></div>` })()}
        <div class="g tile"><div class="lbl">${ICON('i-continue')}Working now</div><div class="num-xl">${fmt(h?.robots.running)}</div><div class="sub">across every agency</div></div>
        <div class="g tile" data-go="work"><div class="lbl">${ICON('i-user')}Waiting for a person</div><div class="num-xl">${fmt(waiting.length)}</div><div class="sub">OTP, captcha, a choice…</div></div>
        <div class="g tile"><div class="lbl">${ICON('i-alert')}Failed this week</div><div class="num-xl">${fmt(failed.length)}</div><div class="sub">${Object.keys(reasons).length} different reasons</div></div>
      </div>
      <div class="cols" style="margin-top:4px">
        <div>
          <div class="sec"><h3>Each robot</h3></div>
          <div class="g"><table style="box-shadow:none;background:transparent"><tr><th>Robot</th><th>Success</th><th>Done</th><th>Failed</th><th>Avg time</th></tr>
            ${((robotsDays === 1 ? h?.robots.today.list : B?.robots) || []).map(r => { const s = r.success ?? (r.done + r.failed ? Math.round(r.done / (r.done + r.failed) * 100) : null); return `<tr><td><b>${esc(wf(r.robot))}</b></td>
              <td style="min-width:140px"><div style="display:flex;gap:8px;align-items:center"><div class="bar2" style="flex:1"><i class="ok" style="width:${s}%"></i><i class="bad" style="width:${100 - s}%"></i></div><b>${pct(s)}</b></div></td>
              <td>${fmt(r.done)}</td><td class="${r.failed ? 'num bad' : ''}">${fmt(r.failed)}</td><td class="muted">${r.avg_s ? `${Math.round(r.avg_s / 6) / 10} min` : '—'}</td></tr>` }).join('') || '<tr><td colspan="5" class="empty">No finished run in this time.</td></tr>'}
          </table></div>
          <div class="sec"><h3>Failed this week</h3><span class="muted" style="font-size:12.5px">${failed.length}</span></div>
          <div class="g needlist">${failed.slice(0, 40).map(r => `<div class="need" data-go="agency/${esc(r.agency.pc_number || r.agency.id)}"><span class="lt red"></span><span class="tx"><b>${esc(r.agency.name)}</b> · ${esc(r.name || '#' + r.profile_id)} · ${esc(wf(r.workflow))} <span class="muted">— ${esc(r.reason || '')}</span></span><span class="muted" style="font-size:12px">${ago(r.at)}</span></div>`).join('') || '<div class="empty">No failure this week.</div>'}</div>
        </div>
        <div>
          <div class="sec"><h3>Why they failed</h3></div>
          <div class="g pad">${Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `<div class="robrow"><span title="${esc(k)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><div class="bar2"><i class="bad" style="width:${n / failed.length * 100}%"></i></div><span class="p">${n}</span></div>`).join('') || '<div class="empty">Nothing failed.</div>'}</div>
          <div class="sec"><h3>Waiting for a person</h3></div>
          <div class="g needlist">${waiting.slice(0, 30).map(r => `<div class="need" data-go="agency/${esc(r.agency.pc_number || r.agency.id)}"><span class="lt amber"></span><span class="tx"><b>${esc(r.agency.name)}</b> · ${esc(r.name || '#' + r.profile_id)} · ${esc(wf(r.workflow))} <span class="muted">— ${esc(r.reason || '')}</span></span><span class="muted" style="font-size:12px">${ago(r.at)}</span></div>`).join('') || '<div class="empty">Nobody is waited for.</div>'}</div>
          <div class="sec"><h3>Per agency</h3></div>
          <div class="g aglist2">${per.map(({ a, run }) => `<div class="r" data-go="agency/${esc(a.pc_number || a.id)}"><span class="lt ${run.failed7d >= 5 ? 'red' : run.failed7d ? 'amber' : 'green'}"></span><span class="nm">${esc(a.name)}</span><span class="why">${run.running || 0} working · ${(run.pending || 0) + (run.paused || 0)} waiting · ${run.failed7d || 0} failed this week</span><span class="tg"><button class="ghost" data-open="${esc(a.id)}">Open Adal Keep</button></span></div>`).join('') || '<div class="empty">No agency sent its work yet.</div>'}</div>
        </div>
      </div>`
    $('#table').querySelectorAll('[data-days]').forEach(b => b.onclick = () => { robotsDays = Number(b.dataset.days); robotsView() })
    $('#table').querySelectorAll('[data-open]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openAgency(b.dataset.open) })
  }
  paint()
  try {
    const [h, B] = await Promise.all([home && Date.now() - homeAt < 10000 ? home : loadHome(), robotsDays === 1 ? null : api(`/api/business?days=${robotsDays}`).catch(e => ({ error: e.message, robots: [] }))])
    if (B) biz[robotsDays] = B
    paint()
  } catch (e) { toast(e.message) }
}

// -------------------------------------------------------------- Releases --
async function releasesView() {
  $('#title').textContent = 'Releases — what every PC runs'
  if (rel) paintReleases(rel); else $('#table').innerHTML = '<div class="empty">Looking at the releases…</div>'
  try { rel = await api('/api/releases'); if (tab === 'releases') paintReleases(rel) } catch (e) { if (!rel) $('#table').innerHTML = `<div class="empty">${esc(e.message)}</div>` }
}
function paintReleases(R) {
  if (document.querySelector('#table select:focus')) return
  const L = R.release
  const STAGE = { test: 'the test agency only', pct: `the test agency + ${L?.rollout?.pct ?? 10}% of agencies`, everyone: 'every PC', stopped: 'nobody new: STOPPED' }
  const next = L?.stage === 'test' && L.rollout ? `${L.rollout.pct}% at ${when(L.rollout.pct_at)}` : L?.stage === 'pct' ? `every PC at ${when(L.everyone_at)}` : ''
  const kb = (n) => n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
  const ACT = { retry: 'try again', keep: 'kept on the old version', everyone: 'pushed to every PC' }
  const onIt = L ? (R.versions.find(v => String(L.sha).startsWith(v.v))?.n || 0) : 0
  $('#table').innerHTML = `
    ${R.error ? `<div class="g pad" style="color:var(--bad);margin-bottom:12px">${esc(R.error)}</div>` : ''}
    <div class="g pad" style="padding:18px 20px">${L ? `
      <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div style="min-width:0;flex:1"><div class="muted" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Published now</div>
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em">${esc(L.short)} <span style="font-size:15px;font-weight:500" class="muted">${esc(L.message || '')}</span></div>
          <div class="muted" style="font-size:13px">${when(L.published_at)} · download ${kb(L.patch)} with the patch (${kb(L.size)} whole)${L.x86 ? ' · 32-bit too' : ''}</div></div>
        <div class="acts2">
          ${L.stage !== 'everyone' && L.stage !== 'stopped' ? `<button class="go" data-roll="advance" title="The next stage now">Advance to ${L.stage === 'test' ? `${L.rollout?.pct ?? 10}%` : 'every PC'}</button>` : ''}
          ${L.stage !== 'everyone' ? '<button class="ghost" data-roll="everyone" title="Every PC now">Everyone now</button>' : ''}
          ${L.stage !== 'stopped' && L.stage !== 'everyone' ? '<button class="danger" data-roll="stop">Stop</button>' : ''}
          ${L.stage === 'stopped' ? '<button class="go" data-roll="resume">Resume</button>' : ''}
        </div></div>
      ${stageTrack(L)}
      <div style="font-size:13.5px">Reaches <b class="${L.stage === 'stopped' ? 'num bad' : ''}">${STAGE[L.stage] || esc(L.stage)}</b>${next ? ` <span class="muted">· next: ${esc(next)}</span>` : ''}</div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px"><div class="bar2" style="flex:1"><i class="tl" style="width:${R.pcs ? onIt / R.pcs * 100 : 0}%"></i></div><span class="muted" style="font-size:12.5px;white-space:nowrap">${onIt} of ${R.pcs} PCs run it</span></div>`
      : '<div class="empty">Nothing published yet. Publish with adal-keep-backend/scripts/publish-update.mjs.</div>'}</div>
    <div class="cols" style="margin-top:4px">
      <div>
        <div class="sec"><h3>Went back by themselves</h3><span class="muted" style="font-size:12.5px">a PC that could not start the new version goes back and says why</span></div>
        <div class="g"><table style="box-shadow:none;background:transparent"><tr><th>PC</th><th>Why</th><th>When</th><th>Next</th></tr>
          ${R.undone.map(u => `<tr><td><b>${esc(u.pc)}</b><div class="muted" style="font-size:12px">${esc(u.agencyName)} · ${esc(u.sha)} → ${esc(u.to || '?')}${u.status === 'could-not-roll-back' ? ' · <b style="color:var(--bad)">could NOT go back</b>' : ''}</div></td>
            <td style="font-size:12.5px">${esc(u.reason)}</td><td class="muted">${ago(u.at)}</td>
            <td>${u.decided ? `<span class="tag">${esc(ACT[u.decided] || u.decided)}</span>` : `<select data-assign="${esc(u.sha)}|${esc(u.pc)}|${esc(u.agency)}"><option value="">Assign…</option><option value="retry">Try again on this PC</option><option value="keep">Keep it on the old version</option><option value="everyone">Push to every PC</option></select>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No PC went back from an update.</td></tr>'}
        </table></div>
        <div class="sec"><h3>Releases</h3></div>
        <div class="g"><table style="box-shadow:none;background:transparent"><tr><th>Version</th><th>What changed</th><th>Published</th><th>PCs on it</th></tr>
          ${R.history.map(hh => `<tr><td><b>${esc(hh.short)}</b>${L && hh.sha === L.sha ? ' <span class="tag ok">now</span>' : ''}${hh.rollback ? ' <span class="tag warn">way back</span>' : ''}</td><td style="font-size:13px">${esc(hh.message || '')}</td><td class="muted">${hh.published_at ? when(hh.published_at) : '—'}</td><td>${hh.pcs}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No release list (the storage list is not readable).</td></tr>'}
        </table></div>
      </div>
      <div>
        <div class="sec"><h3>What every PC runs</h3></div>
        <div class="g pad">${R.versions.map(v => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
          <div style="display:flex;gap:8px;align-items:center"><b>${esc(v.v)}</b>${L && String(L.sha).startsWith(v.v) ? '<span class="tag ok">current</span>' : v.v === 'unknown' ? '' : '<span class="tag">older</span>'}<span class="muted" style="font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.message || '')}</span><b>${v.n}</b></div>
          <div class="tags" style="margin-top:6px">${v.pcs.map(p => `<span class="click" data-go="pc/${esc(p.id)}" title="${esc(p.agency)}"><i class="lt ${p.light}"></i>${esc(p.name)}</span>`).join('')}</div></div>`).join('') || '<div class="empty">No PC has sent a beat yet.</div>'}</div>
        <div class="sec"><h3>How a release goes out</h3></div>
        <div class="g pad muted" style="font-size:13px;line-height:1.6">1. <b>Test</b>: the test agency (and agencies with "Updates first") get it at once.<br>2. <b>${L?.rollout?.pct ?? 10}%</b> of agencies after the hold time.<br>3. <b>All</b> PCs after twice the hold time.<br><b>Advance</b> moves to the next stage now, <b>Stop</b> keeps everyone who has not taken it on their version, <b>Resume</b> goes on. A PC that cannot start a release goes back by itself; <b>Assign</b> what happens to it next.</div>
      </div>
    </div>`
  $('#table').querySelectorAll('[data-roll]').forEach(btn => btn.onclick = async () => {
    if (!(await ask({ title: `${btn.textContent.trim()} — ${L.short}?`, text: btn.dataset.roll === 'stop' ? 'No PC that has not taken it yet will take it, until you press Resume.' : btn.dataset.roll === 'everyone' ? 'Every PC takes it within the next minutes.' : '', ok: btn.textContent.trim(), danger: btn.dataset.roll === 'stop' || btn.dataset.roll === 'everyone' }))) return
    try { const j = await api('/api/updates/rollout', { action: btn.dataset.roll }); toast(`Now reaches ${STAGE[j.stage] || j.stage}`); rel = null; releasesView(); loadHome().catch(() => {}) } catch (e) { tell('Not done', e.message) }
  })
  $('#table').querySelectorAll('[data-assign]').forEach(sel => sel.onchange = async () => {
    const [sha, pc, agency] = sel.dataset.assign.split('|'), action = sel.value
    if (!action) return
    try { await api('/api/updates/assign', { sha, pc, agency, action }); toast(`${sha} on ${pc}: ${ACT[action]}`); rel = null; releasesView() } catch (e) { tell('Not done', e.message); sel.value = '' }
  })
}

// ------------------------------------------------------- one agency page --
// index.html paints what it had (numbers, licence, waiting, receipts) and its
// actions; this adds the rest of the agency and the PC actions.
async function agencyMore(A, pc) {
  const el = $('#aMore')
  if (!el) return
  const head = document.querySelector('.apage')
  if (head && !$('#aHead')) {
    const best = (moreOf[pc]?.pcs || []).map(p => p.light).sort((x, y) => ({ red: 0, amber: 1, green: 2 })[x] - ({ red: 0, amber: 1, green: 2 })[y])[0] || (A.pcOnline ? 'green' : 'red')
    head.insertAdjacentHTML('afterbegin', `<div class="g ahead" id="aHead"><div class="av">${esc(initials(A.name))}</div>
      <div style="min-width:0"><h2>${esc(A.name)} <span class="lt ${best}" title="${LIGHTWORD[best]}"></span></h2>
        <div class="meta"><span>${A.pcOnline ? 'PC on now' : `PC off${A.pcSeen ? ` · last on ${ago(A.pcSeen)} ago` : ''}`}</span><span>PC <b class="code" style="letter-spacing:.06em">${esc(A.pc_number || '—')}</b></span><span>unlock code <b class="code">${esc(A.code || '—')}</b></span><span id="aVer"></span></div></div>
      <div class="acts" id="aActs"></div></div>
      <div class="anav">${[['aPcs', 'PCs'], ['aRob', 'Robots'], ['aTk', 'Tickets'], ['aLic', 'Licence & payments'], ['aSet', 'Setup'], ['aStaff', 'Staff'], ['aWork', 'Work']].map(([id, l]) => `<a data-to="${id}">${l}</a>`).join('')}</div>`)
    head.querySelectorAll('[data-to]').forEach(a => a.onclick = () => document.getElementById(a.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    // The old action buttons move into the head, grouped.
    const acts = $('#aActs'), old = head.querySelector('.head .acts')
    if (old) for (const b of [...old.children]) acts.append(b)
    acts.insertAdjacentHTML('beforeend', `<button class="ghost" id="aUpd" title="Every PC of this agency takes the newest release now">Update now</button><button class="ghost" id="aLogs" title="Its main PC sends its logs (passwords hidden)">Collect logs</button><button class="ghost" id="aNote" title="A note on its PCs, from Adal support">Note to its PCs</button>`)
    const anchor = head.querySelector('.detail'); if (anchor) anchor.id = 'aWork'
  }
  const paint = (M) => {
    if (!$('#aMore') || pageOf !== pc) return
    const L = M.release
    const ver = M.pcs.find(p => p.role === 'main')?.version || M.pcs[0]?.version
    if ($('#aVer')) $('#aVer').innerHTML = ver ? `version <b>${shortV(ver)}</b> ${L && String(ver).startsWith(String(L.sha).slice(0, 7)) ? '<span class="tag ok">current</span>' : L ? `<span class="tag warn">not ${esc(L.short)} yet</span>` : ''}` : ''
    const ids = M.pcs.map(p => p.id), main = M.pcs.find(p => p.role === 'main') || M.pcs[0]
    const send = async (kind, targets, who) => {
      if (!targets.length) return tell('No PC in the control tower', 'This agency\'s PCs have not sent a beat yet (the tower opens for an agency in Fleet → "Open the tower for an agency…").')
      let args = await fleetAsk(kind, who)
      if (args === null) return
      if (kind === 'support_note') { if (!String(args).trim()) return; args = { text: args } }
      try { toast((await api('/api/fleet/command', targets.length > 1 ? { targets, kind, args } : { target: targets[0], kind, args })).message); setTimeout(() => agencyMore(A, pc), 1500) } catch (e) { tell('Not sent', e.message) }
    }
    if ($('#aUpd')) $('#aUpd').onclick = () => send('update_now', ids, A.name)
    if ($('#aLogs')) $('#aLogs').onclick = () => send('collect_logs', main ? [main.id] : [], main?.name || A.name)
    if ($('#aNote')) $('#aNote').onclick = () => send('support_note', ids, A.name)
    const S = M.setup, B = M.billing, R = M.robots
    $('#aMore').innerHTML = `
      <div class="sec" id="aPcs"><h3>PCs (${M.pcs.length})</h3><button class="more" data-go="fleet">Fleet →</button></div>
      <div class="g pad">${M.pcs.map(p => `<div class="pcrow"><span class="lt ${p.light}"></span>
          <div style="min-width:0"><b class="click" data-go="pc/${esc(p.id)}">${esc(p.name)}</b> <span class="tag">${esc(p.role || 'PC')}</span> <span class="tag ${p.current ? 'ok' : 'warn'}">${shortV(p.version)}</span>
            <div class="s">${p.why.length ? esc(p.why.join(' · ')) : 'all fine'} · ${p.employee ? esc(p.employee) + ' · ' : ''}${p.cores ? p.cores + ' cores · ' : ''}${p.ram ? Math.round(p.ram.free_mb / 102.4) / 10 + ' GB RAM free · ' : ''}${p.disk_free_mb != null ? Math.round(p.disk_free_mb / 1024) + ' GB disk · ' : ''}${p.net || ''} · beat ${ago(p.seen)} ago${p.pending?.length ? ` · ${p.pending.length} command(s) waiting` : ''}</div></div>
          <div class="acts2"><button class="ghost" data-cmd="restart|${esc(p.id)}|${esc(p.name)}">Restart</button><button class="ghost" data-cmd="update_now|${esc(p.id)}|${esc(p.name)}">Update</button><button class="ghost" data-cmd="collect_logs|${esc(p.id)}|${esc(p.name)}">Logs</button></div></div>`).join('') || '<div class="empty">No PC of this agency is in the control tower yet.</div>'}
        ${M.pcs.some(p => (p.acks || []).some(a => a.result?.object)) ? `<div style="margin-top:8px" class="acts2">${M.pcs.flatMap(p => (p.acks || []).filter(a => a.result?.object).slice(0, 2).map(a => `<button class="ghost" data-log="${esc(a.result.object)}">Logs of ${esc(p.name)} · ${ago(a.done_at || a.at)} ago</button>`)).join('')}</div>` : ''}</div>
      <div class="agrid2" style="margin-top:14px">
        <div class="g pad" id="aRob"><h4>${ICON('i-robot')} Robots</h4>
          <div class="kvs"><span>Today</span><b>${pct(R.today.success)} <span class="muted" style="font-weight:500">· ${R.today.done} done, ${R.today.failed} failed</span></b>
          <span>7 days</span><b>${pct(R.week.success)} <span class="muted" style="font-weight:500">· ${R.week.done} done, ${R.week.failed} failed</span></b>
          <span>30 days</span><b>${pct(R.month.success)} <span class="muted" style="font-weight:500">· ${R.month.done} done, ${R.month.failed} failed</span></b></div>
          <div style="margin-top:10px">${robotRows(R.week.list) || '<div class="muted" style="font-size:13px">No run this week.</div>'}</div></div>
        <div class="g pad" id="aTk"><h4>${ICON('i-inbox')} Tickets (${M.tickets.filter(t => t.status === 'open').length} open)</h4>
          ${M.tickets.slice(0, 8).map(t => `<div class="row2 click" data-go="tickets/${esc(t.id)}"><span class="lt ${t.status === 'open' ? 'amber' : 'green'}" style="width:8px;height:8px"></span><span class="grow"><b>${esc(String(t.text || '').slice(0, 70))}</b><div class="why">${esc(t.who || '')} · ${esc(t.pc_name || '')} · ${t.status}</div></span><span class="muted">${ago(t.at)}</span></div>`).join('') || '<div class="muted" style="font-size:13px">No ticket from this agency.</div>'}</div>
        <div class="g pad" id="aLic"><h4>${ICON('i-card')} Licence & payments</h4>
          ${B ? `<div class="kvs"><span>Plan</span><b>${esc(String(B.plan || 'premium').replace(/^./, c => c.toUpperCase()))}</b><span>Now</span><b>${renewTag(B.renewal, true) || '—'}</b><span>Ends</span><b>${B.renewal?.ends ? new Date(B.renewal.ends).toLocaleDateString('en-GB') : '—'}</b></div>
            <div style="margin-top:10px">${(B.payments || []).map(p => `<div class="row2"><span class="grow"><b>${etb(p.amount)}</b> · ${esc(p.method)} ${esc(p.reference || '')}</span><span class="muted">${esc(p.date)}</span></div>`).join('') || '<div class="muted" style="font-size:13px">No payment recorded yet.</div>'}</div>` : '<div class="muted" style="font-size:13px">Not a paying PC number.</div>'}
          ${M.receipts.length ? `<div class="tag warn" style="margin-top:8px">${M.receipts.length} receipt(s) waiting for Confirm</div>` : ''}
          <div class="acts2" style="margin-top:10px"><button class="go" data-go="billing">Record a payment</button></div></div>
        <div class="g pad" id="aSet"><h4>${ICON('i-settings')} Setup</h4>
          ${S && !S.error ? `<div class="kvs"><span>Record</span><b>version ${S.version}</b><span>E-mail</span><b>${esc(S.email || '—')}</b><span>LMIS SMS</span><b>${esc(S.lmis || '—')}</b><span>EPRO signature</span><b>${S.epro ? 'on file' : '—'}</b><span>CV templates</span><b>${S.cv_templates}</b><span>Staff roles</span><b>${esc((S.roles || []).join(', ') || '—')}</b><span>Switched on</span><b>${esc((S.on || []).join(', ') || 'nothing extra')}</b></div>`
            : `<div class="muted" style="font-size:13px">${esc(S?.error || 'No setup record yet.')}</div>`}
          <div class="acts2" style="margin-top:10px"><button class="ghost" data-go="setup">Edit the setup</button></div></div>
        <div class="g pad" id="aStaff"><h4>${ICON('i-employees')} Staff (${M.staff.length})</h4>
          ${M.staff.map(s => `<div class="row2"><span class="grow"><b>${esc(s.name)}</b></span>${s.role ? `<span class="tag">${esc(s.role)}</span>` : ''}${s.active ? '' : '<span class="tag">off</span>'}</div>`).join('') || '<div class="muted" style="font-size:13px">Not in its online copy yet.</div>'}</div>
        ${M.went_back.length ? `<div class="g pad"><h4>${ICON('i-rocket')} Went back from an update</h4>${M.went_back.map(u => `<div class="row2"><span class="grow"><b>${esc(u.pc)}</b> · ${esc(u.sha)} → ${esc(u.to || '?')}<div class="why">${esc(u.reason)}</div></span><span class="muted">${ago(u.at)}</span></div>`).join('')}<div class="acts2" style="margin-top:8px"><button class="ghost" data-go="releases">Releases →</button></div></div>` : ''}
      </div>`
    $('#aMore').querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => { const [kind, id, who] = b.dataset.cmd.split('|'); send(kind, [id], who) })
    $('#aMore').querySelectorAll('[data-log]').forEach(b => b.onclick = () => fleetLog(b.dataset.log))
  }
  if (moreOf[pc]) paint(moreOf[pc])
  else el.innerHTML = '<div class="empty">Looking at its PCs, robots, tickets and payments…</div>'
  try { const M = await api(`/api/agency/more?${/^\d{6}$/.test(pc) ? 'pc' : 'id'}=${encodeURIComponent(pc)}`); const was = JSON.stringify(moreOf[pc]); moreOf[pc] = M; if (was !== JSON.stringify(M) || !$('#aMore .sec')) paint(M) }
  catch (e) { if (!moreOf[pc]) el.innerHTML = `<div class="empty">${esc(e.message)}</div>` }
}

// ------------------------------------------------------------- search --
let palList = [], palAt = 0, palT = null, palQ = ''
const PAGES = () => ITEMS.flatMap(n => [{ kind: 'page', title: n.label, sub: `g ${n.k}`, go: n.key, icon: n.icon }, ...(n.subs || []).filter(([k]) => k !== n.key).map(([k, l]) => ({ kind: 'page', title: l, sub: n.label, go: k, icon: n.icon }))])
const KICON = { agency: 'i-building', pc: 'i-monitor', candidate: 'i-user', ticket: 'i-inbox', page: 'i-compass' }
const KNAME = { page: 'Go to', agency: 'Agencies', pc: 'PCs', ticket: 'Tickets', candidate: 'Candidates' }
function palette() {
  $('#pal').classList.add('on'); const I = $('#palI'); I.value = ''; palQ = ''; I.focus(); palDraw(PAGES())
  I.oninput = () => {
    palQ = I.value.trim(); clearTimeout(palT)
    const q = palQ.toLowerCase()
    const pages = PAGES().filter(p => !q || p.title.toLowerCase().includes(q))
    const local = (work || []).filter(a => q && `${a.name} ${a.pc_number}`.toLowerCase().includes(q)).map(a => ({ kind: 'agency', title: a.name, sub: `PC ${a.pc_number || '—'}`, go: `agency/${a.pc_number || a.id}` }))
    palDraw([...pages.slice(0, q ? 4 : 20), ...local])
    if (q.length >= 2) palT = setTimeout(async () => {
      try { const r = await api(`/api/search?q=${encodeURIComponent(palQ)}`); if (r.q === palQ.toLowerCase()) palDraw([...pages.slice(0, 4), ...r.results], true) } catch {}
    }, 160)
  }
  I.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palAt = Math.max(0, Math.min(palList.length - 1, palAt + (e.key === 'ArrowDown' ? 1 : -1))); palMark() }
    else if (e.key === 'Enter') { e.preventDefault(); palPick(palList[palAt], e.ctrlKey || e.metaKey) }
    else if (e.key === 'Escape') closePal()
  }
}
function palDraw(list, done = false) {
  palList = list; palAt = 0
  let last = ''
  $('#palR').innerHTML = list.map((r, i) => {
    const hd = r.kind !== last ? `<div class="hd">${KNAME[r.kind]}</div>` : ''; last = r.kind
    return `${hd}<div class="it" data-i="${i}"><span class="ic2">${ICON(r.icon || KICON[r.kind])}</span><div class="grow"><div class="t">${r.light ? `<span class="lt ${r.light}" style="width:8px;height:8px;margin-right:6px"></span>` : ''}${esc(r.title)}</div><div class="s">${esc(r.sub || '')}</div></div>${r.kind === 'candidate' ? '<span class="kbd" title="Ctrl Enter">open in Adal Keep</span>' : ''}</div>`
  }).join('') || `<div class="empty">${done || palQ.length < 2 ? 'Nothing found.' : 'Looking…'}</div>`
  $('#palR').querySelectorAll('[data-i]').forEach(el => { el.onmousemove = () => { palAt = Number(el.dataset.i); palMark() }; el.onclick = (e) => palPick(palList[Number(el.dataset.i)], e.ctrlKey || e.metaKey || !!e.target.closest('.kbd')) })
  palMark()
}
function palMark() { $('#palR').querySelectorAll('[data-i]').forEach(el => el.classList.toggle('on', Number(el.dataset.i) === palAt)); $('#palR .it.on')?.scrollIntoView({ block: 'nearest' }) }
function palPick(r, alt) {
  if (!r) return
  closePal()
  if (r.kind === 'candidate' && alt) return openAgency(r.agency, `/profiles/${r.profile}`)
  go(r.go)
}
function closePal() { $('#pal')?.classList.remove('on') }
function keys() { $('#keys').classList.toggle('on') }

// -------------------------------------------------------------- theme --
function theme(flip) {
  let t = null; try { t = localStorage.getItem('adm:theme') } catch {}
  const sys = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  if (flip) { t = (t || sys) === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('adm:theme', t) } catch {} }
  const now = t || sys
  document.documentElement.dataset.theme = now
  const b = $('#themeBtn'); if (b) { b.innerHTML = ICON(now === 'dark' ? 'i-sun' : 'i-moon'); b.title = now === 'dark' ? 'Light (t)' : 'Dark (t)' }
}

// ------------------------------------------------------------ shortcuts --
let gAt = 0
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]')
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return $('#pal').classList.contains('on') ? closePal() : palette() }
  if (e.key === 'Escape') { closePal(); $('#keys').classList.remove('on'); if ($('#dlg').style.display === 'flex') $('#dlgNo').click(); return }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#dlg').style.display === 'flex') return
  if (e.key === '/') { e.preventDefault(); return palette() }
  if (e.key === '?') return keys()
  if (Date.now() - gAt < 1200) { gAt = 0; const n = ITEMS.find(x => x.k === e.key.toLowerCase()); if (n) { e.preventDefault(); go(n.key) } return }
  if (e.key === 'g') { gAt = Date.now(); return }
  if (e.key === 't') return theme(true)
  if (e.key === 'r') { refresh(); return toast('Looking again…') }
  if (e.key === ']' || e.key === '[') {
    const g = groupOf(tab); if (!g.subs) return
    const i = g.subs.findIndex(([k]) => k === tab); const n = g.subs[(i + (e.key === ']' ? 1 : g.subs.length - 1)) % g.subs.length]
    go(n[0])
  }
})

// ----------------------------------------------------------------- live --
let liveOk = false, liveT = null, liveAt = 0
function live() {
  let es
  try { es = new EventSource('/api/live') } catch { return }
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.t === 'hello') { liveOk = true; $('#sync').classList.add('live'); return }
    if (m.t === 'changed') { clearTimeout(liveT); liveT = setTimeout(() => { liveAt = Date.now(); homeAt = 0; rel = null; refresh() }, 350) }
  }
  es.onerror = () => { liveOk = false; $('#sync').classList.remove('live') }
}

let built = false
window.SHELL = {
  has: (t) => !!OWN[t],
  view: (t) => { if (!built) return; paintNav(); return OWN[t]() },
  // An old tab button was pressed (index.html): the nav and the address follow.
  tabbed: (t) => {
    if (!built) return
    paintNav()
    const head = location.hash.replace(/^#\/?/, '').split('/')[0]
    const same = head === t || (t === 'agencies' && head === 'agency' && pageOf) || (t === 'fleet' && head === 'pc') || (t === 'tickets' && head === 'tickets')
    if (!same) history.pushState(null, '', `#/${t}`)
  },
  // index.html's refresh(): the frame's counts, and the page shown now when it is one of ours.
  refreshed: () => {
    if (!built) return
    badges(); paintNav()
    if (Date.now() - homeAt > 4000) loadHome().then(() => { if (tab === 'overview') paintOverview(home) }).catch(() => {})
    if (tab === 'overview' && home) paintOverview(home)
    if (tab === 'releases') releasesView()
    if (tab === 'robots' && !document.querySelector('#table button:focus')) robotsView()
  },
  agencyMore, go, liveOk: () => liveOk,
}
document.addEventListener('DOMContentLoaded', () => {
  frame(); built = true
  home = KEPT('home')
  apply(location.hash.replace(/^#\/?/, '') || 'overview')
  live()
})
})()
