/**
 * localCutout.js — the cut-out refine on this PC, for when the cloud is not reachable (the same
 * silueta model as adal-refine's function, services/refineCore.js). Flag: ADAL_LOCAL_CUTOUT=1.
 * The model (43 MB, Apache-2.0) is fetched once into data/models/ (in the background, the first time);
 * until it is there, or without onnxruntime-node, Refine only cleans as before.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SEG_MODEL_URL, SEG_MODEL_BYTES, cutoutRefine, enhanceRefine } from './refineCore.js'
import { verifyModel, modelFile as modelFileOfSr } from './esrganModel.js'

export const localCutoutOn = (env = process.env) => env.ADAL_LOCAL_CUTOUT === '1'
export const modelFile = () => process.env.ADAL_SEG_MODEL || path.join(process.cwd(), 'data', 'models', 'silueta.onnx')
const haveModel = (f = modelFile()) => { try { return fs.statSync(f).size === SEG_MODEL_BYTES } catch { return false } }

let fetching = null
/** Starts the model download if it is missing (once at a time). Never throws. */
export function ensureModel({ fetchFn = fetch, file = modelFile() } = {}) {
  if (haveModel(file)) return Promise.resolve(true)
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const r = await fetchFn(SEG_MODEL_URL, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
      if (!r.ok) throw new Error(`answered ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length !== SEG_MODEL_BYTES) throw new Error(`${buf.length} bytes, expected ${SEG_MODEL_BYTES}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file)
      return true
    } catch (e) { console.warn('[refine] cut-out model not downloaded:', e.message); return false } finally { fetching = null }
  })()
  return fetching
}

/** { buf, ok, note } or null when this PC cannot cut out now (flag off, model not there yet, no runtime, error). */
export async function localCutout(buf, field, { file = modelFile(), fetchFn = fetch } = {}) {
  if (!localCutoutOn()) return null
  if (!haveModel(file)) { ensureModel({ file, fetchFn }); return null }
  try { return await cutoutRefine(buf, field, { modelPath: file }) } catch (e) { console.warn('[refine] local cut-out failed:', e.message); return null }
}

// ── the default engine on the PC: sharper, cleaner, 4K, background kept (Real-ESRGAN, 4.9 MB) ──────────
// Flag ADAL_LOCAL_ENHANCE=1. Skipped on a weak PC (under 4 cores or 7 GB: a 4× network tile by tile would
// swamp it, the cloud does it) — the plain cleaning runs there instead.
export const localEnhanceOn = (env = process.env) => env.ADAL_LOCAL_ENHANCE === '1'
export const srModelFile = () => modelFileOfSr()
// The enhance model is never downloaded by this code (owner, 2026-11-25): a person puts the approved file in data/models/,
// and it is used only when its size and sha256 are exactly right (services/esrganModel.js).
const haveSr = (f = srModelFile()) => verifyModel(f).ok
export const strongEnough = (cores = os.cpus()?.length || 1, mem = os.totalmem() / 1024 ** 3) => cores >= 4 && mem >= 7
export const ensureSrModel = ({ file = srModelFile() } = {}) => Promise.resolve(haveSr(file))
/** { buf, ok, note } or null (flag off, weak PC, model not there yet, no runtime, error). */
export async function localEnhance(buf, field, { file = srModelFile(), fetchFn = fetch, strong = strongEnough() } = {}) {
  if (!localEnhanceOn() || !strong) return null
  if (!haveSr(file)) return null
  try { return await enhanceRefine(buf, field, { modelPath: file, threads: Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1)) }) } catch (e) { console.warn('[refine] local enhance failed:', e.message); return null }
}
