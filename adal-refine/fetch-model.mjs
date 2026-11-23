// Downloads the cut-out model (silueta, U²-Net, Apache-2.0) into models/ once, checking its size. Runs in the Netlify build.
import fs from 'fs'
const URL_ = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx'
const BYTES = 44173029
fs.mkdirSync(new URL('./models/', import.meta.url), { recursive: true })
const out = new URL('./models/silueta.onnx', import.meta.url)
if (fs.existsSync(out) && fs.statSync(out).size === BYTES) { console.log('model already there'); process.exit(0) }
const r = await fetch(URL_, { redirect: 'follow' })
if (!r.ok) throw new Error(`model download answered ${r.status}`)
const buf = Buffer.from(await r.arrayBuffer())
if (buf.length !== BYTES) throw new Error(`model is ${buf.length} bytes, expected ${BYTES}`)
fs.writeFileSync(out, buf)
console.log('model downloaded', buf.length)
