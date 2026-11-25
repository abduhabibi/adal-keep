/**
 * pdfText.js — the text of a PDF, read in a program of its own that ends.
 *
 * Reading a PDF loads its reader and a drawing library into the program: about 350–400 MB that
 * never came back to the PC (the server: 150 MB before, 550–700 MB after the first medical record,
 * 2026-11-25), and 1–2 s in which no page was answered. (Off: ADAL_PDF_CHILD=0, read here.)
 */
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdfTextChild.mjs')
let last = Promise.resolve()

async function here(buf) {
  const m = await import('pdf-parse')
  if (m.PDFParse) { const p = new m.PDFParse({ data: buf }); try { return (await p.getText()).text || '' } finally { await p.destroy?.().catch?.(() => {}) } }
  return (await (m.default || m)(buf)).text || ''
}
function inChild(buf, timeout) {
  return new Promise((ok, no) => {
    const c = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } })
    const out = []
    const t = setTimeout(() => { c.kill('SIGKILL'); no(new Error('The PDF took too long to read')) }, timeout)
    c.on('error', (e) => { clearTimeout(t); no(Object.assign(e, { noChild: true })) })
    c.on('spawn', () => { try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {} })
    c.stdout.on('data', d => out.push(d))
    c.on('close', () => {
      clearTimeout(t)
      try { const r = JSON.parse(Buffer.concat(out).toString()); r.error ? no(new Error(r.error)) : ok(r.text) } catch { no(Object.assign(new Error('The PDF was not read'), { noChild: !out.length })) }
    })
    c.stdin.on('error', () => {})
    c.stdin.end(buf)
  })
}
/** One at a time. Throws when it cannot be read. */
export function pdfText(buf, { timeout = 120_000 } = {}) {
  const run = async () => {
    if (process.env.ADAL_PDF_CHILD === '0') return here(buf)
    try { return await inChild(buf, timeout) } catch (e) { if (e.noChild) return here(buf); throw e }
  }
  const p = last.then(run, run)
  last = p.catch(() => {})
  return p
}
