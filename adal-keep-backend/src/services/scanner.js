/**
 * scanner.js — the PC's scanner, through Windows' own WIA (Windows Image Acquisition) COM.
 * Nothing is downloaded or installed: a hidden PowerShell (no window) talks to WIA.
 *
 *   - Only a person's click starts a scan (the route calls scan()); nothing runs on a timer or at start-up.
 *   - One scan at a time: a second asks gets 'busy'.
 *   - At most TIMEOUT_MS (under 2 minutes), then it is stopped.
 *   - The page comes from the scanner into a temporary file, is turned into a JPEG in memory and the
 *     temporary file is removed at once. The picture waits in memory (5 minutes at most) for the page to take it.
 *   - ADAL_SCAN=0 turns the whole thing off.
 * The PowerShell is run through `run` (a fake in the tests).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'

export const TIMEOUT_MS = 110_000
export const KEEP_MS = 5 * 60_000
const WIA_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'

/** WIA error codes (0x8021xxxx) → what the person is told. */
const WIA_MESSAGES = {
  '80210005': ['off', 'The scanner is off or not connected. Switch it on, check the cable, and try again.'],
  '80210015': ['no-scanner', 'No scanner was found on this PC.'],
  '80210016': ['cover-open', 'The scanner cover is open. Close it and try again.'],
  '80210003': ['paper', 'There is no paper in the scanner.'],
  '80210002': ['paper', 'The paper is jammed. Clear it and try again.'],
  '80210006': ['device-busy', 'The scanner is busy with something else. Wait a moment and try again.'],
  '8021000D': ['device-busy', 'The scanner is in use by another program. Close it and try again.'],
  '8021000A': ['off', 'The PC cannot talk to the scanner. Switch it off and on, check the cable, and try again.'],
  '80210009': ['device-busy', 'The scanner needs attention (see its screen or lights), then try again.'],
  '80210064': ['cancelled', 'The scan was cancelled.'],
}
const NO_DRIVER = 'The scanner is plugged in as a printer only: its scan driver is not installed on this PC (for Epson: "Epson Scan 2"). Scanning needs that driver.'

export const messageFor = (hex) => WIA_MESSAGES[String(hex || '').replace(/^0x/i, '').toUpperCase()] || null

/** The PowerShell for `list` (devices) or `scan` (one page). Output: one line starting @@ with JSON. */
export function script({ action, id = '', dpi = 300, gray = false, out = '' }) {
  const head = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\nfunction emit($o){ '@@' + ($o | ConvertTo-Json -Compress -Depth 4) }\n`
  if (action === 'list') return head + `try { $dm = New-Object -ComObject WIA.DeviceManager
$l = @(); foreach ($i in $dm.DeviceInfos) { if ($i.Type -eq 1) { $n = ''; try { $n = $i.Properties.Item('Name').Value } catch {}; $l += @{ id = $i.DeviceID; name = $n } } }
emit @{ ok = $true; devices = $l } } catch { emit @{ ok = $false; code = ('{0:X8}' -f $_.Exception.HResult); text = $_.Exception.Message } }`
  const safe = String(id).replace(/'/g, "''")
  const o = String(out).replace(/'/g, "''")
  return head + `try { $dm = New-Object -ComObject WIA.DeviceManager
$info = $null; foreach ($i in $dm.DeviceInfos) { if ($i.Type -eq 1 -and ('${safe}' -eq '' -or $i.DeviceID -eq '${safe}')) { $info = $i; break } }
if (-not $info) { emit @{ ok = $false; code = '80210015'; text = 'no scanner' }; exit 0 }
$dev = $info.Connect(); $item = $dev.Items.Item(1)
function setp($name, $v) { try { $item.Properties.Item($name).Value = $v } catch {} }
setp 'Current Intent' ${gray ? 2 : 1}
setp 'Horizontal Resolution' ${dpi}
setp 'Vertical Resolution' ${dpi}
setp 'Horizontal Start Position' 0
setp 'Vertical Start Position' 0
$bw = 8267; $bh = 11692
try { $bw = [int]$dev.Properties.Item('Horizontal Bed Size').Value; $bh = [int]$dev.Properties.Item('Vertical Bed Size').Value } catch {}
setp 'Horizontal Extent' ([int]($bw * ${dpi} / 1000))
setp 'Vertical Extent' ([int]($bh * ${dpi} / 1000))
$img = $item.Transfer('${WIA_PNG}')
# A scanner that only gives BMP (Canon G3030) gives BMP however it is asked: Windows turns it into PNG (sharp reads no BMP).
if ([string]$img.FormatID -ne '${WIA_PNG}') {
  $ip = New-Object -ComObject WIA.ImageProcess
  $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
  $ip.Filters.Item(1).Properties.Item('FormatID').Value = '${WIA_PNG}'
  $img = $ip.Apply($img)
}
$img.SaveFile('${o}')
emit @{ ok = $true } } catch { emit @{ ok = $false; code = ('{0:X8}' -f $_.Exception.HResult); text = $_.Exception.Message } }`
}

/** The real runner: a hidden PowerShell. Resolves { stdout }; rejects on timeout/kill with { killed: true }. */
export function powershell(ps, { timeout = TIMEOUT_MS, onChild = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = Buffer.from(ps, 'utf16le').toString('base64')
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', cmd], { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err && (err.killed || err.signal)) return reject(Object.assign(new Error('stopped'), { killed: true }))
      resolve({ stdout: String(stdout || '') })
    })
    onChild(child)
  })
}
const parse = (stdout) => { const l = String(stdout).split('\n').reverse().find(x => x.startsWith('@@')); try { return l ? JSON.parse(l.slice(2)) : null } catch { return null } }

export function makeScanner({ run = powershell, platform = process.platform, host = os.hostname(), printers = async () => [], toJpeg = defaultJpeg } = {}) {
  let current = null        // { id, state, ... }  one scan at a time
  const kept = new Map()    // id → { jpeg, at }
  const sweep = () => { for (const [k, v] of kept) if (Date.now() - v.at > KEEP_MS) kept.delete(k) }
  const off = () => process.env.ADAL_SCAN === '0'

  async function status() {
    if (off()) return { enabled: false, scanner: null, host, code: 'off-switch', message: 'Scanning is turned off on this PC.', busy: false }
    const base = { enabled: true, host, busy: !!current && current.state === 'scanning' }
    if (platform !== 'win32') return { ...base, scanner: null, code: 'no-scanner', message: 'Scanning works on the Windows PCs only.' }
    let r
    try { r = parse((await run(script({ action: 'list' }), { timeout: 20_000 })).stdout) } catch { r = null }
    if (!r?.ok) return { ...base, scanner: null, code: 'no-scanner', message: 'The scanner list could not be read on this PC.' }
    if (!r.devices?.length) {
      const pr = await printers().catch(() => [])
      return pr.length
        ? { ...base, scanner: null, code: 'driver-missing', message: NO_DRIVER, printers: pr }
        : { ...base, scanner: null, code: 'no-scanner', message: 'No scanner was found on this PC. Connect one, switch it on and try again.' }
    }
    const d = r.devices[0]
    return { ...base, scanner: { id: d.id, name: d.name || 'Scanner' }, others: r.devices.slice(1).map(x => x.name), code: 'ready', message: `Scanner: ${d.name || 'Scanner'} on ${host}` }
  }

  /** Start a scan (on a person's click). Returns { id } or { error: { code, message } } at once; the page asks scanStatus(id). */
  function start({ dpi = 300, gray = false, device = '' } = {}) {
    if (off()) return { error: { code: 'off-switch', message: 'Scanning is turned off on this PC.' } }
    if (platform !== 'win32') return { error: { code: 'no-scanner', message: 'Scanning works on the Windows PCs only.' } }
    if (current && current.state === 'scanning') return { error: { code: 'busy', message: 'The scanner is in use: another scan is running. Wait until it is done.' } }
    const d = [150, 200, 300, 600].includes(Number(dpi)) ? Number(dpi) : 300
    const id = crypto.randomBytes(6).toString('hex')
    const tmp = path.join(os.tmpdir(), `adal-scan-${id}.png`)
    const job = current = { id, state: 'scanning', at: Date.now(), child: null, cancelled: false }
    ;(async () => {
      try {
        const r = parse((await run(script({ action: 'scan', id: device, dpi: d, gray: !!gray, out: tmp }), { timeout: TIMEOUT_MS, onChild: (c) => { job.child = c } })).stdout)
        if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true })
        if (!r) throw Object.assign(new Error('no answer'), { code: 'failed' })
        if (!r.ok) {
          const m = messageFor(r.code)
          throw Object.assign(new Error(m ? m[1] : `The scan failed (${String(r.text || '').slice(0, 120)}).`), { code: m ? m[0] : 'failed' })
        }
        if (!fs.existsSync(tmp)) throw Object.assign(new Error('The scanner gave no picture.'), { code: 'failed' })
        const jpeg = await toJpeg(fs.readFileSync(tmp))
        sweep(); kept.set(id, { jpeg, at: Date.now() })
        job.state = 'done'
      } catch (e) {
        job.state = 'error'
        if (job.cancelled || e.cancelled) job.error = { code: 'cancelled', message: 'The scan was cancelled.' }
        else if (e.killed) job.error = { code: 'timeout', message: 'The scan took too long and was stopped (over 2 minutes). Check the scanner and try again.' }
        else job.error = { code: e.code || 'failed', message: e.message || 'The scan failed.' }
      } finally { try { fs.unlinkSync(tmp) } catch {} }
    })()
    return { id }
  }

  const scanStatus = (id) => (current && current.id === id ? { state: current.state, ...(current.error ? { error: current.error } : {}) } : kept.has(id) ? { state: 'done' } : null)
  /** The picture, once: it is taken out of memory as it is handed over. */
  const take = (id) => { const k = kept.get(id); if (!k) return null; kept.delete(id); return k.jpeg }
  function cancel() { if (!current || current.state !== 'scanning') return false; current.cancelled = true; try { current.child?.kill() } catch {}; return true }
  return { status, start, scanStatus, take, cancel }
}

async function defaultJpeg(png) {
  const sharp = (await import('sharp')).default
  return sharp(png).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
}

/** The PC's printers (names only), to tell "printer with no scan driver" from "nothing connected". */
export function listPrinters() {
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Printer | ForEach-Object Name'], { windowsHide: true, timeout: 10_000 },
    (e, o) => res(e ? [] : String(o).split('\n').map(s => s.trim()).filter(s => s && !/pdf|xps|onenote|fax/i.test(s)))))
}
