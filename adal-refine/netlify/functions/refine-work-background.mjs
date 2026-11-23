// Background function (up to 15 minutes): the work may take longer than a normal function may.
// REFINE_ENGINE=enhance (default, free: Real-ESRGAN in ONNX: sharper, cleaner, 4K), cutout (white background, silueta) or gemini (billed key).
import { getStore } from '@netlify/blobs'
import { fileURLToPath } from 'url'
import { work } from './_lib.mjs'

const keys = () => String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(/[,;\s]+/).filter(Boolean)
// The model is put in models/ by the build (fetch-model.mjs) and shipped with the function (netlify.toml included_files).
const srModelPath = process.env.SR_MODEL_PATH || fileURLToPath(new URL('../../models/realesr-general-x4v3.onnx', import.meta.url))
const modelPath = process.env.SEG_MODEL_PATH || fileURLToPath(new URL('../../models/silueta.onnx', import.meta.url))
export default async (req) => {
  await work(new URL(req.url).searchParams.get('job') || '', { store: getStore('refine'), keys: keys(), engine: process.env.REFINE_ENGINE || 'enhance', modelPath, srModelPath })
}
