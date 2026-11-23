#!/usr/bin/env node
/**
 * Live robot check on the agency's Main PC (run by Adal from the Linux PC when it is on the office Wi-Fi):
 *   node adal-keep-backend/scripts/live-robot-check.mjs [--ip 192.168.1.50] [--profile 749] [--workflow musaned_check_chosen] [--minutes 8]
 *
 * 1. finds DESKTOP-1ACAO6S on the LAN (MAC 00:11:7f:b7:d8:40 via `ip neigh`, then a ping sweep of the /24, then the hostname);
 * 2. over ssh prints the installed release, whether :4000 answers and whether the queue is idle;
 * 3. if idle, starts ONE read-only run (no retry, nothing submitted, no password typed) from Main itself;
 * 4. follows the run every 5 s (at most 8 minutes), printing each step with its time;
 * 5. on a captcha prints the site, URL, step and the stop picture (copied here) so the owner can solve it.
 * Ends with one PASS or FAIL line; exit 0 only for PASS (2 = bad arguments).
 */
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAIN = { mac: '00:11:7f:b7:d8:40', host: 'DESKTOP-1ACAO6S', user: 'hp' }
const CAPTCHA = /re-?captcha|captcha|not a robot|verify you are human/i
const DONE = new Set(['done', 'failed', 'cancelled'])

export function parseArgs(argv) {
  const o = { ip: '', profile: 749, workflow: 'musaned_check_chosen', minutes: 8, key: path.join(os.homedir(), '.ssh', 'adal-remote') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--ip') o.ip = v()
    else if (a === '--profile') o.profile = Number(v())
    else if (a === '--workflow') o.workflow = v()
    else if (a === '--minutes') o.minutes = Number(v())
    else if (a === '--key') o.key = v()
    else throw new Error(`unknown argument ${a}`)
  }
  if (o.ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(o.ip)) throw new Error(`--ip must be an IPv4 address, got "${o.ip}"`)
  if (!Number.isInteger(o.profile) || o.profile < 1) throw new Error('--profile must be a number')
  if (!/^[a-z0-9_]+$/.test(o.workflow)) throw new Error('--workflow must be a workflow id')
  if (!(o.minutes > 0 && o.minutes <= 9)) throw new Error('--minutes must be between 1 and 9 (no step over 10 minutes)')
  return o
}

/** `ip neigh` / `arp -an` text → the IPv4 whose MAC matches, or ''. */
export function ipForMac(text, mac = MAIN.mac) {
  const want = mac.toLowerCase().replace(/-/g, ':')
  for (const line of String(text).split('\n')) {
    const m = line.toLowerCase().match(/(\d{1,3}(?:\.\d{1,3}){3})/)
    const l = line.toLowerCase().replace(/-/g, ':')
    if (m && l.includes(want)) return m[1]
  }
  return ''
}

/** `ip -4 -o addr` text → the /24 prefixes ("192.168.1") of real interfaces (not lo/docker). */
export function subnetsOf(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+)\.\d+\/(\d+)/)
    if (m && !/^(lo|docker|br-|veth|virbr)/.test(m[1]) && !out.includes(m[2])) out.push(m[2])
  }
  return out
}

/** One automation row (from the API) → what to print. */
export function describeRun(row, seen = 0) {
  const log = Array.isArray(row?.log) ? row.log : []
  const lines = log.slice(seen).map(l => ({ time: l.ts ? new Date(l.ts).toISOString().slice(11, 19) : '--:--:--', level: l.level || 'info', msg: String(l.msg || '') }))
  return { lines, total: log.length }
}

/** All the run's text → { captcha, line, url }. The URL is from the captcha line, else the last URL seen. */
export function findCaptcha(row, historyReason = '') {
  const texts = [...(Array.isArray(row?.log) ? row.log.map(l => String(l.msg || '')) : []), String(row?.pause_reason || ''), String(historyReason || '')]
  const hit = texts.find(t => CAPTCHA.test(t))
  const url = (s) => (String(s).match(/https?:\/\/[^\s"')]+/) || [''])[0]
  const last = [...texts].reverse().map(url).find(Boolean) || ''
  return { captcha: !!hit, line: hit || '', url: (hit && url(hit)) || last }
}

/** The error to show: last ✗/❌/error line of the log, else the pause reason. */
export function errorOf(row) {
  const log = Array.isArray(row?.log) ? row.log : []
  const bad = [...log].reverse().find(l => l.level === 'error' || /^(✗|❌|⛔)/.test(String(l.msg || '')))
  return bad ? String(bad.msg) : String(row?.pause_reason || '')
}

/** PASS only when the run finished `done` and no captcha stopped it. */
export function verdict(status, captcha) {
  if (captcha) return { pass: false, why: 'a captcha stopped the run — the owner must solve it' }
  if (status === 'done') return { pass: true, why: 'the run finished' }
  if (status === 'paused') return { pass: false, why: 'the run paused and waits for a person' }
  if (status === 'timeout') return { pass: false, why: 'the run did not finish in time (it may still be working on Main)' }
  return { pass: false, why: `the run ended as ${status}` }
}

// ---------------------------------------------------------------------------

const sh = (cmd, args, timeout = 15000) => spawnSync(cmd, args, { encoding: 'utf8', timeout })

function discover(o) {
  if (o.ip) return { ip: o.ip, how: 'given' }
  const find = () => ipForMac(sh('ip', ['neigh']).stdout) || ipForMac(sh('arp', ['-an']).stdout)
  let ip = find()
  if (ip) return { ip, how: 'ip neigh' }
  for (const net of subnetsOf(sh('ip', ['-4', '-o', 'addr']).stdout)) {
    console.log(`  ping sweep ${net}.0/24 …`)
    sh('bash', ['-c', `for i in $(seq 1 254); do ping -c1 -W1 ${net}.$i >/dev/null 2>&1 & done; wait`], 40000)
    ip = find()
    if (ip) return { ip, how: `ping sweep of ${net}.0/24` }
  }
  const r = sh('getent', ['hosts', MAIN.host])
  const m = String(r.stdout).match(/(\d+\.\d+\.\d+\.\d+)/)
  if (m) return { ip: m[1], how: `hostname ${MAIN.host}` }
  return { ip: '', how: '' }
}

const hostsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-robot-')), 'known_hosts')
const sshArgs = (o, ip) => ['-i', o.key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${hostsFile}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', `${MAIN.user}@${ip}`]
// The remote shell may be cmd: send PowerShell as one encoded command so nothing is quoted wrongly.
const encode = (ps) => ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$ProgressPreference='SilentlyContinue'\n${ps}`, 'utf16le').toString('base64')]

function ps(o, ip, script, timeout = 30000) {
  return sh('ssh', [...sshArgs(o, ip), ...encode(script)], timeout)
}

const API = 'http://127.0.0.1:4000/api'

const PROBE = `
$out = [ordered]@{}
foreach ($d in 'C:\\AdalKeep','C:\\AdalKeep\\adal-keep-backend') {
  $f = Join-Path $d '.adal-version.json'
  if (Test-Path $f) { $out.release = (Get-Content $f -Raw | ConvertFrom-Json); $out.releaseFile = $f; break }
}
try { $out.active = @(Invoke-RestMethod -TimeoutSec 8 "${API}/automations/active"); $out.up = $true } catch { $out.up = $false; $out.err = $_.Exception.Message }
if ($out.up) { try { $out.queue = (Invoke-RestMethod -TimeoutSec 8 "${API}/profiles/PROFILE/automations").queue } catch { $out.queueErr = $_.Exception.Message } }
'@@' + ($out | ConvertTo-Json -Compress -Depth 6)`

const startScript = (o) => `
try { $r = Invoke-RestMethod -TimeoutSec 30 -Method Post -ContentType 'application/json' -Body '{}' "${API}/profiles/${o.profile}/automations/${o.workflow}/start"; '@@' + ($r | ConvertTo-Json -Compress -Depth 4) }
catch { $b = ''; try { $b = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}; '@@' + (@{ ok = $false; error = $_.Exception.Message; body = $b } | ConvertTo-Json -Compress) }`

// One ssh session for the whole run: a loop on Main prints one JSON line every 5 s and stops at the end.
const pollScript = (runId, seconds) => `
$end = (Get-Date).AddSeconds(${seconds})
while ($true) {
  try { $r = Invoke-RestMethod -TimeoutSec 10 "${API}/automations/${runId}"; '@@' + (@{ status = $r.status; step = $r.current_step; pause_reason = $r.pause_reason; log = @($r.log) } | ConvertTo-Json -Compress -Depth 5); if (@('done','failed','cancelled','paused') -contains $r.status) { break } }
  catch { '@@' + (@{ poll_error = $_.Exception.Message } | ConvertTo-Json -Compress) }
  if ((Get-Date) -gt $end) { '@@' + (@{ status = 'timeout' } | ConvertTo-Json -Compress); break }
  Start-Sleep -Seconds 5
}`

const json = (out) => { const l = String(out).split('\n').reverse().find(x => x.startsWith('@@')); try { return l ? JSON.parse(l.slice(2)) : null } catch { return null } }

async function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`FAIL: ${e.message}`); process.exit(2) }
  const fail = (m) => { console.log(`\nFAIL — ${m}`); process.exit(1) }

  console.log(`1. Looking for ${MAIN.host} (${MAIN.mac})`)
  const found = discover(o)
  if (!found.ip) fail(`${MAIN.host} not found on this network (is this PC on the office Wi-Fi?)`)
  console.log(`   ${found.ip}  (${found.how})`)

  console.log('2. Main PC state')
  const probe = ps(o, found.ip, PROBE.replace('PROFILE', o.profile))
  const st = json(probe.stdout)
  if (!st) fail(`ssh to ${found.ip} gave no answer: ${(probe.stderr || probe.error?.message || probe.stdout || '').trim().slice(0, 300)}`)
  const rel = st.release || {}
  console.log(`   release   : ${rel.sha ? `${String(rel.sha).slice(0, 10)}  date ${rel.date || '?'}  published ${rel.published_at || '?'}  seq ${rel.seq ?? '?'}` : 'not found (no .adal-version.json)'}${st.releaseFile ? `  [${st.releaseFile}]` : ''}`)
  console.log(`   :4000     : ${st.up ? 'answers' : `NOT answering (${st.err || ''})`}`)
  if (!st.up) fail('the API on :4000 does not answer')
  const running = st.queue?.running?.length || 0
  const active = Array.isArray(st.active) ? st.active.length : 0
  console.log(`   queue     : ${running} running, ${active} active/waiting/paused → ${running + active === 0 ? 'idle' : 'BUSY'}`)
  if (running + active > 0) fail('the automation queue is not idle — one robot at a time, nothing started')

  console.log(`3. Starting ONE read-only run: ${o.workflow} on profile ${o.profile} (no retry)`)
  const s = json(ps(o, found.ip, startScript(o), 45000).stdout)
  if (!s || s.ok === false || !s.runId) fail(`start was refused: ${JSON.stringify(s)?.slice(0, 400)}`)
  console.log(`   run #${s.runId}  ${s.message || ''}`)

  console.log(`4. Following run #${s.runId} every 5 s, at most ${o.minutes} min`)
  let seen = 0, last = null, status = 'timeout'
  await new Promise((resolve) => {
    const p = spawn('ssh', [...sshArgs(o, found.ip), ...encode(pollScript(s.runId, o.minutes * 60))])
    const kill = setTimeout(() => p.kill(), (o.minutes * 60 + 60) * 1000)
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      const parts = buf.split('\n'); buf = parts.pop()
      for (const line of parts.filter(x => x.startsWith('@@'))) {
        let r; try { r = JSON.parse(line.slice(2)) } catch { continue }
        if (r.poll_error) { console.log(`   (poll error: ${r.poll_error})`); continue }
        if (r.status === 'timeout') { status = 'timeout'; continue }
        const d = describeRun(r, seen); seen = d.total
        for (const l of d.lines) console.log(`   ${l.time}  ${l.level === 'error' ? '✗ ' : ''}${l.msg}`)
        last = r; status = r.status
      }
    })
    p.on('close', () => { clearTimeout(kill); resolve() })
  })
  if (!last) fail(`lost contact with Main — run #${s.runId} may still be working there`)

  console.log(`\n   end result : ${status}`)
  const err = errorOf(last)
  console.log(`   error      : ${err || '(none)'}`)

  // The run history row: the site, the stop step and the picture.
  const h = json(ps(o, found.ip, `try { $h = Invoke-RestMethod -TimeoutSec 10 "${API}/run-history?profile_id=${o.profile}&limit=10" | Where-Object { $_.run_id -eq ${s.runId} } | Select-Object -First 1; '@@' + ($h | ConvertTo-Json -Compress) } catch { '@@null' }`).stdout) || {}
  const cap = findCaptcha(last, h.reason)
  if (cap.captcha || status !== 'done') {
    console.log(`   history    : site ${h.site || '?'} · step ${h.step || '?'} · ${h.outcome || '?'}${h.reason ? ` · ${h.reason}` : ''}`)
  }
  if (cap.captcha) {
    console.log(`\n   CAPTCHA — site: ${h.site || '(see log)'}`)
    console.log(`            URL : ${cap.url || '(not in the log)'}`)
    console.log(`            step: ${h.step || cap.line}`)
  }
  if (h.id && h.has_shot) {
    const remote = `$env:TEMP\\live-robot-${h.id}.jpg`
    ps(o, found.ip, `Invoke-WebRequest -TimeoutSec 15 -UseBasicParsing -OutFile "${remote}" "${API}/run-history/${h.id}/shot"`)
    const local = path.join(process.cwd(), `live-robot-stop-${h.id}.jpg`)
    const cp = sh('scp', ['-i', o.key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${hostsFile}`, '-o', 'ConnectTimeout=8', `${MAIN.user}@${found.ip}:${`C:/Users/${MAIN.user}/AppData/Local/Temp/live-robot-${h.id}.jpg`}`, local])
    console.log(`   stop screenshot: ${cp.status === 0 ? local : `on Main, run history #${h.id} (GET ${API}/run-history/${h.id}/shot); copy failed`}`)
  }

  const v = verdict(status, cap.captcha)
  console.log(`\n${v.pass ? 'PASS' : 'FAIL'} — ${v.why} (run #${s.runId}, ${found.ip})`)
  process.exit(v.pass ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
