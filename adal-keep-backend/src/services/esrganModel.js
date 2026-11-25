/**
 * esrganModel.js — the Real-ESRGAN model file, loaded only if it is exactly the file the owner approved.
 * realesr-general-x4v3.onnx, 4,866,417 bytes, sha256 below (checked by the CEO on 2026-11-25; BSD-3-Clause).
 * It lives in data/models/ and is put there by a person. This code NEVER downloads it.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export const MODEL_BYTES = 4866417
export const MODEL_SHA256 = '1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112'
export const modelFile = () => process.env.ADAL_SR_MODEL || path.join(process.cwd(), 'data', 'models', 'realesr-general-x4v3.onnx')

const seen = new Map()   // file → { key: size:mtime, ok } — hashed once per file version
/** { ok, reason } — the file exists, is the exact size and has the exact sha256. */
export function verifyModel(file = modelFile(), { bytes = MODEL_BYTES, sha256 = MODEL_SHA256 } = {}) {
  let st
  try { st = fs.statSync(file) } catch { return { ok: false, reason: 'the model file is not in data/models' } }
  if (st.size !== bytes) return { ok: false, reason: `the model file is ${st.size} bytes, expected ${bytes}` }
  const key = `${st.size}:${st.mtimeMs}:${sha256}`
  const hit = seen.get(file)
  if (hit && hit.key === key) return hit.res
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const res = got === sha256 ? { ok: true, reason: '' } : { ok: false, reason: 'the model file has the wrong checksum' }
  seen.set(file, { key, res })
  return res
}
/** The flag: off unless ADAL_REFINE_ESRGAN=1. */
export const esrganOn = () => process.env.ADAL_REFINE_ESRGAN === '1'
