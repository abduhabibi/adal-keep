// The Real-ESRGAN ×4 in its own process (services/faithfulRefine.js starts it): the server is never blocked and a
// time limit can kill it. Input: argv[2] = a JSON { src, out, model, threads }; the picture is a file, the answer a raw RGB file.
import fs from 'fs'
import { upscale4x } from './refineCore.js'

try {
  const { src, out, model, threads } = JSON.parse(process.argv[2])
  const up = await upscale4x(fs.readFileSync(src), { modelPath: model, threads })
  fs.writeFileSync(out, up.raw)
  process.send({ ok: true, w: up.w, h: up.h })
} catch (e) {
  process.send({ ok: false, error: String(e.message || e).slice(0, 300) })
}
process.exit(0)
