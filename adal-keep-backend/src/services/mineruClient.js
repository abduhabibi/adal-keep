/**
 * mineruClient.js
 *
 * Thin client for the MinerU "precise parse" API (v4) — a layout-aware
 * OCR engine that turns scanned PDFs / images into clean Markdown.
 *
 * Flow (documented at https://mineru.net/apiManage/docs):
 *   1. POST /api/v4/file-urls/batch        → { batch_id, file_urls: [ ... ] }
 *   2. PUT  <file_urls[0]>  (raw bytes)    → 200/201
 *   3. GET  /api/v4/extract-results/batch/<batch_id>  (poll until state==='done')
 *   4. GET  <full_zip_url>                 → zip containing full.md
 *
 * Auth: `Authorization: Bearer <MINERU_API_TOKEN>` (or the encrypted secret store).
 */

import fs from 'fs/promises'
import path from 'path'
import zlib from 'zlib'
import { getSecret } from './secretStore.js'

const API_BASE = String(process.env.MINERU_API_BASE || 'https://mineru.net').replace(/\/+$/, '')
const UPLOAD_PATH = '/api/v4/file-urls/batch'
const RESULT_PATH = '/api/v4/extract-results/batch/'

// MinerU accepts: PDF, images (png/jpg/jpeg/jp2/webp/gif/bmp) and Office docs.
const ALLOWED_EXT = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.jp2', '.gif', '.bmp',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
])

// ---------- config helpers ----------

export function getToken() {
  return String(getSecret('MINERU_API_TOKEN') || process.env.MINERU_API_TOKEN || '').trim()
}

/** True when MinerU is switched on AND a token is available. */
export function isMineruConfigured() {
  if (String(process.env.MINERU_ENABLED || '').toLowerCase() === 'false') return false
  return !!getToken()
}

// ---------- low level helpers ----------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ac.signal })
  } finally {
    clearTimeout(to)
  }
}

/**
 * Dependency-free ZIP entry reader (stored + deflate, no zip64).
 * MinerU result archives are small and use standard deflate entries.
 */
function extractZipEntry(buf, predicate) {
  const EOCD_SIG = 0x06054b50
  const CENTRAL_SIG = 0x02014b50

  const minPos = Math.max(0, buf.length - 22 - 65535)
  let eocd = -1
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('MinerU: result archive is not a valid zip')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIG) break

    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    if (predicate(name)) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(start, start + compSize)
      if (method === 0) return Buffer.from(raw)         // stored
      if (method === 8) return zlib.inflateRawSync(raw) // deflate
      throw new Error(`MinerU: unsupported zip compression method ${method}`)
    }

    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/**
 * Smaller upload = faster MinerU turnaround. Large phone photos are scaled to
 * 1800px on the long side and re-encoded as JPEG; documents and PDFs go as-is.
 * The original file is never touched.
 */
async function prepareUpload(filePath) {
  const filename = path.basename(filePath)
  const raw = await fs.readFile(filePath)
  if (!/\.(jpe?g|png|webp)$/i.test(filename) || raw.length < 800 * 1024) {
    return { buf: raw, filename }
  }
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(raw).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer()
    return { buf: out, filename: filename.replace(/\.(jpe?g|png|webp)$/i, '.jpg') }
  } catch {
    return { buf: raw, filename }
  }
}

// ---------- main entry ----------

/**
 * Parse a local document with MinerU and return its Markdown text.
 *
 * @param {string} filePath   local path to the document
 * @param {object} [opts]
 * @param {string} [opts.modelVersion]  'pipeline' (default, fast) | 'vlm' (most accurate)
 * @param {string} [opts.language]      MinerU language pack, default 'en'
 * @param {boolean}[opts.isOcr]         force OCR, default true
 * @param {number} [opts.timeoutMs]     overall poll budget, default 180000
 * @param {number} [opts.pollMs]        poll interval, default 3000
 * @returns {Promise<string>} Markdown text of the document
 */
export async function parseDocumentToMarkdown(filePath, opts = {}) {
  const token = getToken()
  if (!token) throw new Error('MINERU_API_TOKEN not configured')

  const ext = path.extname(filePath).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) throw new Error(`MinerU: unsupported file type ${ext}`)

  const timeoutMs = Number(opts.timeoutMs || process.env.MINERU_TIMEOUT_MS) || 180000
  const pollMs = Number(opts.pollMs || process.env.MINERU_POLL_MS) || 1500
  const modelVersion = opts.modelVersion || process.env.MINERU_MODEL || 'pipeline'
  const language = opts.language || process.env.MINERU_LANGUAGE || 'en'
  const isOcr = opts.isOcr ?? String(process.env.MINERU_OCR || 'true').toLowerCase() !== 'false'

  const { buf, filename } = await prepareUpload(filePath)
  const dataId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(-18)

  // ---------- 1. request a pre-signed upload URL ----------
  const createRes = await fetchWithTimeout(`${API_BASE}${UPLOAD_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      enable_formula: false,
      enable_table: true,
      language,
      model_version: modelVersion,
      files: [{ name: filename, is_ocr: isOcr, data_id: dataId }],
    }),
  }, 30000)

  if (!createRes.ok) {
    const t = await createRes.text()
    throw new Error(`MinerU create task HTTP ${createRes.status}: ${t.slice(0, 200)}`)
  }
  const created = await createRes.json()
  if (created.code !== 0) {
    throw new Error(`MinerU create task failed (${created.code}): ${created.msg || 'unknown'}`)
  }
  const batchId = created.data?.batch_id
  const uploadUrl = created.data?.file_urls?.[0]
  if (!batchId || !uploadUrl) throw new Error('MinerU: response missing batch_id / file_urls')

  // ---------- 2. upload the bytes ----------
  const upRes = await fetchWithTimeout(uploadUrl, { method: 'PUT', body: buf }, 120000)
  if (!upRes.ok) throw new Error(`MinerU upload HTTP ${upRes.status}`)

  // ---------- 3. poll until done ----------
  const deadline = Date.now() + timeoutMs
  let zipUrl = null
  let lastState = 'pending'

  while (Date.now() < deadline) {
    await sleep(pollMs)
    let json
    try {
      const r = await fetchWithTimeout(`${API_BASE}${RESULT_PATH}${batchId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
      }, 30000)
      json = await r.json()
    } catch (e) {
      console.warn('[mineru] poll error (will retry):', e.message)
      continue
    }

    if (json.code !== 0) continue

    const item = json.data?.extract_result?.[0]
    if (!item) continue

    lastState = item.state
    if (item.state === 'done') { zipUrl = item.full_zip_url; break }
    if (item.state === 'failed') {
      throw new Error(`MinerU parse failed: ${item.err_msg || 'unknown error'}`)
    }
  }

  if (!zipUrl) throw new Error(`MinerU timed out after ${timeoutMs}ms (last state: ${lastState})`)

  // ---------- 4. download archive and pull out full.md ----------
  const zipRes = await fetchWithTimeout(zipUrl, {}, 120000)
  if (!zipRes.ok) throw new Error(`MinerU archive download HTTP ${zipRes.status}`)

  const zipBuf = Buffer.from(await zipRes.arrayBuffer())
  const md = extractZipEntry(zipBuf, name => /(^|\/)full\.md$/i.test(name))
  if (!md) throw new Error('MinerU: full.md not found in result archive')

  return md.toString('utf8')
}

export default { parseDocumentToMarkdown, isMineruConfigured, getToken }
