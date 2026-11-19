/**
 * insuranceFetch.js — "Get insurance certificate" (workflow id: insurance_fetch).
 * Asked on 2026-11-19.
 *
 * FetaP issues a certificate about 24 hours after it was requested, and its
 * Issued Certificates list (/certificate/approved) cannot be searched by name.
 * So Adal Keep remembers when her insurance was requested (her
 * insurance_certificate run) and how many were on that certificate, and:
 *
 *   1. signs in to FetaP (the same sign-in as the insurance robot)
 *   2. Certificate → Issued Certificates
 *   3. opens Details of the issued batches of that day (and the days after),
 *      the batch with as many certificates as hers first
 *   4. finds her row by passport number → View Certificate
 *   5. saves the PDF as her Insurance document
 *
 * Her insurance already on her profile: nothing is done, the agency is told.
 */
import { insuranceSignIn } from './insuranceCertificate.js'

export const INSURANCE_FETCH = 'insurance_fetch'
const APPROVED_URL = 'https://agency.niscofetap.com/certificate/approved'
const DAY = 24 * 60 * 60 * 1000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = (ctx) => typeof ctx?.isCancelled === 'function' && ctx.isCancelled()
const text = (page) => page.evaluate(() => document.body?.innerText || '').catch(() => '')

function log(ctx, msg, level = 'info') {
  if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
  console.log(`[insurance-fetch] ${ctx?.runId ? `run #${ctx.runId} ` : ''}${msg}`)
  ctx?.onLog?.(level, msg)?.catch?.(() => {})
}

async function until(test, ms, ctx) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelled(ctx)) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    if (await test().catch(() => false)) return true
    await sleep(500)
  }
  return false
}

/** Her insurance requests on FetaP: how many, the last one's day and how many were on it. */
export async function insuranceHistory(db, profileId) {
  const rows = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: 'insurance_certificate' })
    .where(function () { this.where('status', 'done').orWhere('status', 'paused') })
    .orderBy('created_at', 'desc')
    .select('id', 'status', 'pause_reason', 'created_at', 'context')
    .catch(() => [])
  if (!rows.length) return { count: 0, last: null, size: 1 }
  const last = rows[0]
  // On a shared certificate: her row waits "with-run-<id>"; everyone on it counts.
  const leader = /^with-run-(\d+)$/.exec(last.pause_reason || '')?.[1]
  const runId = leader ? Number(leader) : last.id
  let size = 1
  try {
    const members = await db('automation_queue').where('pause_reason', `with-run-${runId}`).count({ c: '*' }).first()
    size = 1 + Number(members?.c || 0)
  } catch {}
  return { count: rows.length, last: last.created_at, size }
}

/** The day of a date in this PC's own time (YYYY-MM-DD). */
export function dayOf(v) {
  const d = new Date(v)
  if (isNaN(d)) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Which batches of the Issued Certificates list to open, in order: from the day
 * before her request to 6 days after; the same day first, then the days after;
 * a batch with as many certificates as hers before the others of its day.
 */
export function pickBatches(rows, requestedAt, size = 1) {
  const req = requestedAt ? new Date(dayOf(requestedAt)) : null
  const scored = rows.map(r => {
    const d = new Date(r.date)
    if (isNaN(d)) return null
    const days = req ? Math.round((d - req) / DAY) : 0
    if (req && (days < -1 || days > 6)) return null
    return { ...r, rank: (days < 0 ? 10 : days) * 2 + (Number(r.count) === Number(size) ? 0 : 1) }
  }).filter(Boolean)
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, req ? 12 : 6)
}

/** The rows of the Issued Certificates table: index, issued date and how many certificates. */
const readBatches = (page) => page.evaluate(() => {
  const head = [...document.querySelectorAll('th')].map(th => (th.innerText || '').trim().toLowerCase())
  const iDate = head.findIndex(h => /issued date/.test(h))
  const iCount = head.findIndex(h => /^certificates?$/.test(h))
  return [...document.querySelectorAll('tbody tr')].map((tr, index) => {
    const td = [...tr.querySelectorAll('td')].map(t => (t.innerText || '').trim())
    const details = [...tr.querySelectorAll('a, button')].some(b => /details/i.test(b.innerText || ''))
    return { index, date: td[iDate] || '', count: Number(td[iCount]) || 0, details }
  }).filter(r => r.details && /^\d{4}-\d{2}-\d{2}/.test(r.date))
})

async function openApproved(page, ctx) {
  await page.goto(APPROVED_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
  const ok = await until(async () => /Issued Date/i.test(await text(page)) && (await readBatches(page)).length > 0, 60000, ctx)
  if (!ok) throw new Error('The Issued Certificates list did not load')
}

/** The PDF bytes the View Certificate button gives (a download, a new tab or a page of its own). */
async function captureCertificate(page, ctx, rowSel) {
  let pdf = null
  const onResponse = async (r) => {
    try {
      if (pdf) return
      const type = String(r.headers()['content-type'] || '')
      if (/application\/pdf/i.test(type) || /\.pdf(\?|$)/i.test(r.url())) {
        const b = await r.buffer().catch(() => null)
        if (b && b.slice(0, 4).toString() === '%PDF') pdf = b
      }
    } catch {}
  }
  page.on('response', onResponse)
  const newTab = page.browser().waitForTarget(t => t.opener() === page.target(), { timeout: 30000 }).catch(() => null)
  await page.click(rowSel).catch(() => {})
  await until(async () => !!pdf, 8000, ctx).catch(() => false)
  let tab = null
  if (!pdf) {
    const target = await newTab
    tab = target ? await target.page().catch(() => null) : null
    if (tab) {
      tab.on('response', onResponse)
      await tab.waitForNetworkIdle({ idleTime: 1500, timeout: 45000 }).catch(() => {})
      await until(async () => !!pdf, 5000, ctx).catch(() => false)
      if (!pdf) {
        // A PDF the tab shows: fetched with the tab's own sign-in.
        const fetched = await tab.evaluate(async () => {
          try {
            const r = await fetch(location.href, { credentials: 'include' })
            if (!/pdf/i.test(r.headers.get('content-type') || '')) return null
            return [...new Uint8Array(await r.arrayBuffer())]
          } catch { return null }
        }).catch(() => null)
        if (fetched) pdf = Buffer.from(fetched)
      }
      if (!pdf) {
        // The certificate is a page of its own: printed to PDF as it shows.
        pdf = await tab.pdf({ format: 'A4', printBackground: true }).then(b => Buffer.from(b)).catch(() => null)
        if (pdf) log(ctx, 'the certificate is a page — saved as a PDF of that page')
      }
    }
  }
  page.off('response', onResponse)
  if (tab) await tab.close().catch(() => {})
  return pdf && pdf.slice(0, 4).toString() === '%PDF' ? pdf : null
}

export async function runInsuranceFetch(page, ctx) {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const p = ctx.profile || {}
  const passport = String(p.passport_number || '').trim().toUpperCase()
  if (!passport) return { ok: false, step: 'preflight', error: 'The profile has no passport number', seconds: 0 }
  if (ctx.insurancePath) {
    await ctx.notify(`ℹ️ ${ctx.profileName}: insurance already done`, 'Her insurance certificate is already on her profile (Documents → Insurance). Nothing was downloaded.')
    return { ok: true, note: 'insurance certificate already on the profile', seconds: 0 }
  }
  const hist = ctx.db ? await insuranceHistory(ctx.db, p.id) : { count: 0, last: null, size: 1 }
  log(ctx, hist.last
    ? `her insurance was requested on ${dayOf(hist.last)} (${hist.count} time${hist.count === 1 ? '' : 's'}; ${hist.size} on that certificate)`
    : 'no insurance request of hers is recorded — looking at the newest issued batches')

  await insuranceSignIn(page, ctx)
  await openApproved(page, ctx)
  const batches = pickBatches(await readBatches(page), hist.last, hist.size)
  if (!batches.length) {
    const why = hist.last ? `no batch issued between ${dayOf(new Date(new Date(hist.last) - DAY))} and 6 days after her request` : 'no issued batches'
    log(ctx, why, 'warn')
    return { ok: false, step: 'list', error: `Not issued yet: ${why}`, seconds: secs() }
  }
  log(ctx, `batches to look in: ${batches.map(b => `${b.date} (${b.count})`).join(', ')}`)

  for (const b of batches) {
    // Details of that row (the list is loaded again for each batch).
    if (!/\/certificate\/approved/i.test(page.url())) await openApproved(page, ctx)
    const clicked = await page.evaluate((i) => {
      const tr = document.querySelectorAll('tbody tr')[i]
      const a = tr && [...tr.querySelectorAll('a, button')].find(x => /details/i.test(x.innerText || ''))
      if (!a) return false
      a.scrollIntoView({ block: 'center' }); a.click(); return true
    }, b.index)
    if (!clicked) continue
    const opened = await until(async () => /approvedClients|policy\//i.test(page.url()) && /Passport Number/i.test(await text(page)), 45000, ctx)
    if (!opened) { log(ctx, `the batch of ${b.date} did not open`, 'warn'); await openApproved(page, ctx); continue }
    await sleep(800)
    const found = await page.evaluate((pp) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(r => (r.innerText || '').toUpperCase().replace(/\s+/g, ' ').includes(pp))
      const v = tr && [...tr.querySelectorAll('a, button')].find(x => /view certificate/i.test(x.innerText || ''))
      if (!v) return null
      v.setAttribute('data-adal-view', '1')
      return (tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    }, passport)
    if (!found) { log(ctx, `not in the batch of ${b.date} (${b.count})`); await openApproved(page, ctx); continue }
    log(ctx, `✓ found her in the batch of ${b.date}: ${found}`)

    const pdf = await captureCertificate(page, ctx, '[data-adal-view="1"]')
    if (!pdf) {
      await page.bringToFront().catch(() => {})
      await ctx.notify(`🖐 ${ctx.profileName}: insurance certificate found — download it`, `She is in the FetaP batch of ${b.date}. Adal Keep pressed View Certificate but could not take the PDF; download it in the FetaP tab and add it to Documents → Insurance.`, 'warn')
      return { ok: true, note: `found in the batch of ${b.date} — the PDF was not taken`, seconds: secs() }
    }
    const { savePdf } = await import('./musanedContracts.js')
    await savePdf(ctx.db, p.id, 'Insurance', pdf, `Insurance_${passport}.pdf`)
    await ctx.noteProfile?.(`Insurance: the FetaP certificate of ${b.date} is saved to Documents → Insurance`)
    await ctx.notify(`🛡 ${ctx.profileName}: insurance certificate saved`, `Taken from FetaP (issued ${b.date}) and saved to Documents → Insurance.`)
    log(ctx, `✅ saved her insurance certificate (${Math.round(pdf.length / 1024)} KB)`)
    return { ok: true, note: `insurance certificate of ${b.date} saved`, seconds: secs() }
  }

  log(ctx, 'she is in none of those batches yet', 'warn')
  return { ok: false, step: 'search', error: `Not issued yet: passport ${passport} is in none of the batches since ${hist.last ? dayOf(hist.last) : 'the newest ones'}`, seconds: secs() }
}
