/**
 * Demo documents — drawn as SVG (made-up people) and served at the same
 * /api/files/:id/{thumbnail,download} addresses the real app uses, through a
 * small service worker (public/adal-demo-sw.js) that answers from Cache Storage.
 */
const CACHE = 'adal-demo-files'
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const SKIN = ['#8d5a3b', '#6b4329', '#a06a45', '#7a4b2e']
const CLOTH = ['#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#b45309']

function person(i, x, y, s, full) {
  const skin = SKIN[i % SKIN.length], cloth = CLOTH[i % CLOTH.length]
  const head = `<circle cx="${x}" cy="${y}" r="${22 * s}" fill="${skin}"/><path d="M${x - 24 * s} ${y - 4 * s}q${24 * s}-${36 * s} ${48 * s} 0v-${8 * s}q-${24 * s}-${26 * s}-${48 * s} 0z" fill="#1f2937"/>`
  if (!full) return `${head}<path d="M${x - 60 * s} ${y + 90 * s}q0-${58 * s} ${60 * s}-${62 * s}q${60 * s} ${4 * s} ${60 * s} ${62 * s}z" fill="${cloth}"/>`
  return `${head}<rect x="${x - 30 * s}" y="${y + 26 * s}" width="${60 * s}" height="${110 * s}" rx="${18 * s}" fill="${cloth}"/>
    <rect x="${x - 26 * s}" y="${y + 130 * s}" width="${22 * s}" height="${90 * s}" rx="${8 * s}" fill="#334155"/>
    <rect x="${x + 4 * s}" y="${y + 130 * s}" width="${22 * s}" height="${90 * s}" rx="${8 * s}" fill="#334155"/>`
}

function svg(kind, p, i) {
  const w = (body, W = 600, H = 800, bg = '#f8fafc') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`
  if (kind === 'photo') return w(person(i, 300, 300, 4.2, false), 600, 700, '#e2e8f0')
  if (kind === 'fullbody') return w(`<rect y="640" width="600" height="160" fill="#cbd5e1"/>${person(i, 300, 150, 2.4, true)}`, 600, 800, '#e2e8f0')
  if (kind === 'slip') return w(`
    <rect x="40" y="40" width="520" height="720" rx="18" fill="#fff" stroke="#cbd5e1"/>
    <text x="300" y="110" font-size="30" font-family="sans-serif" text-anchor="middle" fill="#0f766e" font-weight="700">DEMO BANK</text>
    <text x="300" y="150" font-size="18" font-family="sans-serif" text-anchor="middle" fill="#64748b">Transfer receipt</text>
    ${[['Order ID', p.order_id || 'FT00000000'], ['Debit account', '1000****1234'], ['Credit account', 'Demo Agency PLC'], ['Amount', '1,000.00 ETB'], ['For', p.full_name]].map(([k, v], n) =>
      `<text x="80" y="${240 + n * 70}" font-size="18" font-family="sans-serif" fill="#64748b">${k}</text><text x="80" y="${268 + n * 70}" font-size="22" font-family="monospace" fill="#0f172a">${esc(v)}</text>`).join('')}
    <text x="300" y="720" font-size="40" font-family="sans-serif" text-anchor="middle" fill="#dc2626" opacity=".25" font-weight="800">SPECIMEN</text>`)
  if (kind === 'medical') return w(`
    <rect x="40" y="40" width="520" height="720" rx="18" fill="#fff" stroke="#cbd5e1"/>
    <text x="300" y="110" font-size="28" font-family="sans-serif" text-anchor="middle" fill="#1d4ed8" font-weight="700">MEDICAL REPORT</text>
    ${[['Name', p.full_name], ['Blood group', 'O+'], ['Chest X-ray', 'Normal'], ['Result', 'FIT FOR WORK']].map(([k, v], n) =>
      `<text x="80" y="${200 + n * 80}" font-size="18" font-family="sans-serif" fill="#64748b">${k}</text><text x="80" y="${230 + n * 80}" font-size="24" font-family="sans-serif" fill="#0f172a">${esc(v)}</text>`).join('')}
    <text x="300" y="700" font-size="40" font-family="sans-serif" text-anchor="middle" fill="#dc2626" opacity=".25" font-weight="800">SPECIMEN</text>`)
  // passport data page
  const dob = (p.date_of_birth || '1990-01-01').replace(/-/g, '').slice(2)
  const exp = (p.passport_expiry_date || '2030-01-01').replace(/-/g, '').slice(2)
  const l1 = `P<ETH${(p.last_name || '').replace(/ /g, '<')}<<${(p.first_name + '<' + (p.middle_name || '')).replace(/ /g, '<')}`.padEnd(44, '<').slice(0, 44)
  const l2 = `${p.passport_number}0ETH${dob}0${p.gender || 'F'}${exp}0`.padEnd(42, '<') + '00'
  return w(`
    <rect x="20" y="20" width="860" height="560" rx="20" fill="#f0fdf4" stroke="#86efac"/>
    <text x="50" y="70" font-size="22" font-family="sans-serif" fill="#166534">Federal Democratic Republic of Ethiopia · PASSPORT</text>
    <rect x="50" y="100" width="200" height="250" rx="8" fill="#e2e8f0"/><svg x="50" y="100" width="200" height="250" viewBox="0 0 600 700">${person(i, 300, 300, 4.2, false)}</svg>
    ${[['Surname', p.last_name], ['Given names', `${p.first_name} ${p.middle_name || ''}`], ['Passport No.', p.passport_number], ['Date of birth', p.date_of_birth], ['Place of birth', p.place_of_birth], ['Date of expiry', p.passport_expiry_date]].map(([k, v], n) =>
      `<text x="290" y="${120 + n * 44}" font-size="14" font-family="sans-serif" fill="#64748b">${k}</text><text x="290" y="${140 + n * 44}" font-size="20" font-family="sans-serif" fill="#0f172a" font-weight="600">${esc(v)}</text>`).join('')}
    <text x="450" y="300" font-size="64" font-family="sans-serif" text-anchor="middle" fill="#dc2626" opacity=".18" font-weight="800" transform="rotate(-18 450 300)">SPECIMEN</text>
    <text x="50" y="500" font-size="25" font-family="monospace" fill="#0f172a">${esc(l1)}</text>
    <text x="50" y="545" font-size="25" font-family="monospace" fill="#0f172a">${esc(l2)}</text>`, 900, 600, '#f8fafc')
}

/** Put every demo document into Cache Storage. */
export async function seedFiles(db) {
  if (!('caches' in window)) return
  const cache = await caches.open(CACHE)
  await Promise.all(db.files.filter(f => f.kind !== 'upload').map(async f => {
    const p = db.profiles.find(x => x.id === f.profile_id)
    if (!p) return
    const blob = new Blob([svg(f.kind, p, p.id)], { type: 'image/svg+xml' })
    for (const v of ['thumbnail', 'download']) await cache.put(`/api/files/${f.id}/${v}`, new Response(blob, { headers: { 'Content-Type': 'image/svg+xml' } }))
  }))
}

/** A file a visitor uploads in the demo: kept in their browser only. */
export async function storeUpload(id, blob) {
  if (!('caches' in window)) return
  const cache = await caches.open(CACHE)
  for (const v of ['thumbnail', 'download']) await cache.put(`/api/files/${id}/${v}`, new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } }))
}

/** Start the service worker that serves /api/files/* from the cache. */
export async function startFileWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/adal-demo-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => {
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
        setTimeout(r, 3000)
      })
    }
  } catch (e) {
    console.warn('[demo] file worker not started:', e.message)
  }
}
