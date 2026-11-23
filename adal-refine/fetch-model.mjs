// Downloads the models into models/ once, checking their sizes. Runs in the Netlify build.
//  realesr-general-x4v3 (Real-ESRGAN, BSD-3-Clause, 4.9 MB): the default "enhance" engine.
//  silueta (U²-Net, Apache-2.0, 43 MB): only for REFINE_ENGINE=cutout.
import fs from 'fs'
const MODELS = [
  ['realesr-general-x4v3.onnx', 'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx', 4866417],
  ['silueta.onnx', 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx', 44173029],
]
fs.mkdirSync(new URL('./models/', import.meta.url), { recursive: true })
for (const [name, url, bytes] of MODELS) {
  const out = new URL(`./models/${name}`, import.meta.url)
  if (fs.existsSync(out) && fs.statSync(out).size === bytes) { console.log(name, 'already there'); continue }
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`${name}: download answered ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length !== bytes) throw new Error(`${name} is ${buf.length} bytes, expected ${bytes}`)
  fs.writeFileSync(out, buf)
  console.log(name, 'downloaded', buf.length)
}
