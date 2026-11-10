/**
 * The agency's signed contract for EPRO approve (Settings → Integrations →
 * EPRO signature): uploaded once, kept in data/epro-signature/, given to
 * Musaned's Contract Upload by the EPRO robot. PDF, PNG or JPG, up to 5 MB
 * (Musaned's own limits).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'epro-signature')
const OK = /\.(pdf|png|jpe?g)$/i

export function eproSignature() {
  try {
    const name = fs.readdirSync(DIR).find(n => OK.test(n))
    if (!name) return null
    const p = path.join(DIR, name)
    return { name, path: p, size: fs.statSync(p).size, at: fs.statSync(p).mtime.toISOString() }
  } catch { return null }
}

export function saveEproSignature(buffer, original) {
  const name = path.basename(String(original || 'signed-contract.pdf')).replace(/[^\w. ()-]/g, '_')
  if (!OK.test(name)) throw Object.assign(new Error('Musaned takes a PDF, PNG or JPG'), { status: 400 })
  if (buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error('Musaned takes files up to 5 MB'), { status: 400 })
  fs.mkdirSync(DIR, { recursive: true })
  for (const n of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, n), { force: true })
  fs.writeFileSync(path.join(DIR, name), buffer)
  return eproSignature()
}

export function removeEproSignature() {
  try { for (const n of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, n), { force: true }) } catch {}
}
