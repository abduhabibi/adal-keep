// A made-up portrait (no real person) and the measures used to judge a refine: shared by
// scripts/bench-refine.mjs and tests/faithfulRefine.test.js.
import sharp from 'sharp'

/** A synthetic head-and-shoulders portrait, long side `H` px: skin with pore noise, eyes, brows, lips, hair strands, a patterned head covering. */
export async function portrait(H = 1920, seed = 7) {
  const W = Math.round(H * 0.75)
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const strands = Array.from({ length: 90 }, () => { const x = W * (0.2 + rnd() * 0.6), y = H * (0.12 + rnd() * 0.12); return `<path d="M${x} ${y} q${(rnd() - 0.5) * 80} ${40 + rnd() * 60} ${(rnd() - 0.5) * 120} ${100 + rnd() * 80}" stroke="rgba(30,20,15,${0.35 + rnd() * 0.4})" stroke-width="${1 + rnd() * 1.5}" fill="none"/>` }).join('')
  const weave = Array.from({ length: 40 }, (_, i) => `<line x1="${W * 0.1}" y1="${H * 0.62 + i * 9}" x2="${W * 0.9}" y2="${H * 0.62 + i * 9 + 18}" stroke="rgba(255,255,255,.25)" stroke-width="2"/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><radialGradient id="sk" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#b98560"/><stop offset="1" stop-color="#8a5a3c"/></radialGradient>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe6ee"/><stop offset="1" stop-color="#b9c4d2"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#bg)"/>
<path d="M0 ${H} L0 ${H * 0.78} Q${W * 0.5} ${H * 0.62} ${W} ${H * 0.78} L${W} ${H} Z" fill="#3b5a7a"/>${weave}
<ellipse cx="${W / 2}" cy="${H * 0.42}" rx="${W * 0.26}" ry="${H * 0.25}" fill="url(#sk)"/>
<path d="M${W * 0.22} ${H * 0.4} Q${W * 0.5} ${H * 0.02} ${W * 0.78} ${H * 0.4} Q${W * 0.5} ${H * 0.18} ${W * 0.22} ${H * 0.4}Z" fill="#2a2020"/>${strands}
<g fill="#fff"><ellipse cx="${W * 0.4}" cy="${H * 0.4}" rx="${W * 0.04}" ry="${H * 0.012}"/><ellipse cx="${W * 0.6}" cy="${H * 0.4}" rx="${W * 0.04}" ry="${H * 0.012}"/></g>
<g fill="#3a2a1e"><circle cx="${W * 0.4}" cy="${H * 0.4}" r="${W * 0.015}"/><circle cx="${W * 0.6}" cy="${H * 0.4}" r="${W * 0.015}"/></g>
<g stroke="#1c120c" stroke-width="3" fill="none"><path d="M${W * 0.34} ${H * 0.375} q${W * 0.06} -${H * 0.02} ${W * 0.12} 0"/><path d="M${W * 0.54} ${H * 0.375} q${W * 0.06} -${H * 0.02} ${W * 0.12} 0"/><path d="M${W * 0.5} ${H * 0.42} l-6 ${H * 0.06} l12 0"/></g>
<path d="M${W * 0.43} ${H * 0.53} q${W * 0.07} ${H * 0.03} ${W * 0.14} 0 q-${W * 0.07} ${H * 0.02} -${W * 0.14} 0z" fill="#7b2f3a"/>
<g font-family="Liberation Sans, Arial" font-size="${H * 0.018}" fill="#223"><text x="${W * 0.08}" y="${H * 0.93}">ADAL TEST PORTRAIT 0123456789</text></g></svg>`
  const base = await sharp(Buffer.from(svg)).png().toBuffer()
  // skin pores / fabric grain: seeded noise laid over everything, strongest on the skin
  const noise = await sharp({ create: { width: W, height: H, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 18 } } }).png().toBuffer()
  return sharp(base).composite([{ input: noise, blend: 'soft-light' }]).png().toBuffer()
}

/** WhatsApp-like damage: shrunk to `long` px and JPEG'd hard at 4:2:0. */
export async function degrade(buf, { long = 960, q = 42 } = {}) {
  return sharp(buf).resize({ width: long, height: long, fit: 'inside' }).jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer()
}

const raw = async (b, w, h) => sharp(b).resize({ width: w, height: h, fit: 'fill' }).removeAlpha().raw().toBuffer()
const luma = (d) => { const n = d.length / 3, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = 0.299 * d[i * 3] + 0.587 * d[i * 3 + 1] + 0.114 * d[i * 3 + 2]; return o }
export async function psnr(a, b, w, h) {
  const A = luma(await raw(a, w, h)), B = luma(await raw(b, w, h))
  let e = 0; for (let i = 0; i < A.length; i++) e += (A[i] - B[i]) ** 2
  e /= A.length; return e === 0 ? 99 : 10 * Math.log10(255 * 255 / e)
}
/** Mean colour of the picture (appearance: lighter / darker / more saturated shows here). */
export async function meanRGB(buf) {
  const { data, info } = await sharp(buf).resize({ width: 256 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const m = [0, 0, 0]; const n = info.width * info.height
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) m[c] += data[i * 3 + c]
  return m.map(v => v / n)
}
/** Fine-detail energy (mean absolute gradient of the luma): sharper = more. */
export async function detail(buf, w = 960) {
  const { data, info } = await sharp(buf).resize({ width: w }).grayscale().raw().toBuffer({ resolveWithObject: true })
  let s = 0; const W = info.width, H = info.height
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) s += Math.abs(data[y * W + x] - data[y * W + x + 1]) + Math.abs(data[y * W + x] - data[(y + 1) * W + x])
  return s / (W * H)
}
