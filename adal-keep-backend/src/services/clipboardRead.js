/**
 * clipboardRead.js — what is copied on THIS PC, for the Paste button of a document box
 * (asked on 2026-11-26). Only for a window on this PC itself (routes/clipboard.js checks
 * it): another PC's clipboard is never read. The page reads pictures itself
 * (navigator.clipboard); this is for what a page cannot read: files copied in Explorer,
 * and a picture when the page is not allowed to read the clipboard.
 *
 *   readClipboard() → { kind: 'files', files: [{ name, type, data: Buffer }] }
 *                   | { kind: 'none' | 'text' | 'other', ... }   (nothing to put in a box)
 *
 * Windows: PowerShell (STA) with System.Windows.Forms.Clipboard, at most 8 s.
 * Off: ADAL_PASTE_BUTTON=0.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'

export const pasteOn = () => process.env.ADAL_PASTE_BUTTON !== '0'
export const MAX = 20 * 1024 * 1024
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.pdf': 'application/pdf' }
export const typeOf = (name) => TYPES[path.extname(String(name)).toLowerCase()] || ''

const PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$out = @{ kind = 'none' }
if ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $out = @{ kind = 'paths'; paths = @([Windows.Forms.Clipboard]::GetFileDropList()) }
} elseif ([Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [Windows.Forms.Clipboard]::GetImage()
  $p = Join-Path $env:TEMP ('adal-paste-' + [guid]::NewGuid().ToString() + '.png')
  $img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $out = @{ kind = 'image'; path = $p }
} elseif ([Windows.Forms.Clipboard]::ContainsText()) {
  $out = @{ kind = 'text' }
} elseif ([Windows.Forms.Clipboard]::GetDataObject().GetFormats().Length -gt 0) {
  $out = @{ kind = 'other' }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress))
`

function askWindows() {
  return new Promise((ok, no) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (e, out) => {
        if (e) return no(new Error(e.killed ? 'Windows did not answer about the clipboard in 8 s' : 'Windows could not read the clipboard'))
        try { ok(JSON.parse(String(out).trim() || '{}')) } catch { no(new Error('Windows gave an answer that could not be read')) }
      })
  })
}

/** ask: what the clipboard holds as { kind, paths?, path? } (tests give their own). */
export async function readClipboard({ ask = process.platform === 'win32' ? askWindows : null } = {}) {
  if (!ask) return { kind: 'unsupported' }
  const got = await ask()
  const paths = got.kind === 'paths' ? [].concat(got.paths || []) : got.kind === 'image' && got.path ? [got.path] : []
  if (!paths.length) return { kind: got.kind === 'paths' || got.kind === 'image' ? 'none' : got.kind || 'none' }
  const files = [], refused = []
  let total = 0
  for (const p of paths) {
    const st = await fs.promises.stat(p).catch(() => null)
    const name = got.kind === 'image' ? 'Pasted picture.png' : path.basename(p)
    const type = got.kind === 'image' ? 'image/png' : typeOf(p)
    if (!st || !st.isFile() || !type) { refused.push(path.basename(p)); continue }
    if (st.size > MAX || total + st.size > MAX * 2) { refused.push(`${path.basename(p)} (too big)`); continue }
    total += st.size
    files.push({ name, type, data: await fs.promises.readFile(p) })
  }
  if (got.kind === 'image') fs.promises.rm(paths[0], { force: true }).catch(() => {})
  return files.length ? { kind: 'files', files, refused } : { kind: 'not-documents', refused }
}
