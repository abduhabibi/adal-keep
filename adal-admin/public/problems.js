// Problems (PCs / Fleet → Problems): every PC's own report, by agency and PC — what is new
// since yesterday first, how often, failed runs and where they stopped, the slowest steps,
// a machine short of memory, disk, processor or internet (problems.mjs). Read-only.
window.problemsView = async function problemsView() {
  $('#title').textContent = 'Problems — what every PC reports by itself'
  let P
  try { P = await api('/api/fleet/problems') } catch (e) { $('#table').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return }
  if (tab !== 'problems') return
  if (!P.agencies.length) { $('#table').innerHTML = '<p class="muted">No PC has sent a report yet. PCs send one every 5 minutes from the version with reports.</p>'; return }
  const gb = (mb) => mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`
  const err = (e) => `<tr><td>${e.new ? '<b class="bad">new</b>' : ''}</td><td class="muted">${esc(e.source)}</td><td style="font-size:12px;word-break:break-word">${esc(e.line)}</td>
    <td style="text-align:right">${e.today || 0}</td><td style="text-align:right" class="muted">${e.yesterday || 0}</td><td class="muted">${ago(e.last)}</td></tr>`
  const pc = (p) => `<details class="box2" style="margin:8px 0" ${p.score ? 'open' : ''}>
    <summary><b>${esc(p.name || 'PC')}</b> · PC ${esc(p.pc_number || '—')} · ${esc(p.role || '')} · version ${esc(String(p.version || '—').slice(0, 7))}
      · <span class="${p.new_count ? 'bad' : 'muted'}">${p.new_count} new</span> · ${p.today_count} today · ${p.runs_failed.length} failed runs
      <span class="muted">· report ${ago(p.at)} ago</span></summary>
    ${p.warnings.length ? `<p class="bad">${p.warnings.map(esc).join(' · ')}</p>` : ''}
    <p class="muted" style="font-size:12px">Memory ${gb(p.sys?.ram_free_mb)} free of ${gb(p.sys?.ram_total_mb)} · disk ${gb(p.sys?.disk_free_mb)} free · processor ${p.sys?.cpu_busy ?? '—'}% (${p.sys?.cores ?? '?'} cores) · internet ${p.net?.mbps ?? '—'} Mbit/s, ${p.net?.rtt_ms ?? '—'} ms</p>
    ${p.errors.length ? `<table><tr><th></th><th>Log</th><th>Line</th><th>Today</th><th>Yesterday</th><th>Last</th></tr>${p.errors.map(err).join('')}</table>` : '<p class="muted">No errors in its logs today or yesterday.</p>'}
    ${p.runs_failed.length ? `<h4>Runs that failed or stopped today</h4><table><tr><th>Run</th><th>How</th><th>Stopped at</th><th>Why</th><th>When</th></tr>${p.runs_failed.map(r => `<tr><td>${esc(r.workflow || '')} <span class="muted">${esc(r.site || '')}</span></td><td>${esc(r.outcome)}</td><td style="font-size:12px">${esc(r.step || '—')}</td><td style="font-size:12px">${esc(r.reason || '—')}</td><td class="muted">${ago(r.at)}</td></tr>`).join('')}</table>` : ''}
    ${p.slow_steps.length ? `<h4>Slowest steps today</h4><table><tr><th>Run</th><th>Step</th><th>Longest</th><th>Average</th><th>Times</th></tr>${p.slow_steps.map(s => `<tr><td>${esc(s.workflow || '')}</td><td style="font-size:12px">${esc(s.step)}</td><td>${s.max_s}s</td><td class="muted">${s.avg_s}s</td><td class="muted">${s.times}</td></tr>`).join('')}</table>` : ''}
  </details>`
  $('#table').innerHTML = P.agencies.map(a => `<section style="margin-bottom:18px"><h3>${esc(a.name)} <span class="${a.new_count ? 'bad' : 'muted'}" style="font-size:13px">${a.new_count} new since yesterday · ${a.pcs.length} PC${a.pcs.length === 1 ? '' : 's'}</span></h3>${a.pcs.map(pc).join('')}</section>`).join('')
}
