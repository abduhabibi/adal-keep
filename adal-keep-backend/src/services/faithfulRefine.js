/**
 * faithfulRefine.js — "Refine" that keeps her exactly as she is (owner, 2026-11-25: "her appearance must
 * not change"). It only works on the pixels the picture already has:
 *
 *   1. JPEG blocking / colour blotches are softened where they are worst: the colour channels get a light
 *      blur (the eye hardly sees colour detail; WhatsApp-type compression damages it most), the brightness
 *      channel is left alone apart from a very light de-ringing.
 *   2. The picture is enlarged with Lanczos to the size the person chose — original, 2K (2048) or 4K (3840)
 *      on the long side. Never smaller than the original, and 'original' adds no pixels at all.
 *   3. A small unsharp mask, scaled to the enlargement, gives the edges back their snap.
 *   4. JPEG at quality 95, 4:4:4 (no colour loss), the original stays on the profile.
 *
 * Not done on purpose: no generated face, no skin lightening, no brightness / saturation / gamma change, no
 * reshaping, no cloud (nothing leaves this PC). Enlarging adds pixels, not detail: a 1280 px WhatsApp photo
 * at 4K is a smoother, cleaner 1280 px photo, not a sharper face. (The AI upscaler Real-ESRGAN is not used
 * here: its model file is not on the PCs; see docs/photo-quality.md for what it would take.)
 * ADAL_PHOTO_QUALITY=0 turns the new refine off (the old button behaviour comes back).
 */
import sharp from 'sharp'

export const SIZES = { original: 0, '2k': 2048, '4k': 3840 }
export const on = () => process.env.ADAL_PHOTO_QUALITY !== '0'

/** The settings, by name — the bench (scripts/bench-refine.mjs) picks them by measurement. */
export const PARAMS = { chromaSigma: 0.9, lumaSigma: 0, sharpSigma: 1.1, sharpAmount: 0.4 }

async function softenColour(buf, p) {
  if (!p.chromaSigma && !p.lumaSigma) return buf
  // BT.601 YCbCr by hand: Y (brightness) stays, Cb and Cr (colour) get the blur.
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height, n = w * h, ch = info.channels
  const Y = Buffer.alloc(n), Cb = Buffer.alloc(n), Cr = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2]
    Y[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    Cb[i] = Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)
    Cr[i] = Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)
  }
  const blur = (b, s) => (s ? sharp(b, { raw: { width: w, height: h, channels: 1 } }).blur({ sigma: s, precision: 'float', minAmplitude: 0.01 }).extractChannel(0).raw().toBuffer() : b)
  const [y, cb, cr] = await Promise.all([blur(Y, p.lumaSigma), blur(Cb, p.chromaSigma), blur(Cr, p.chromaSigma)])
  const out = Buffer.alloc(n * 3)
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  for (let i = 0; i < n; i++) {
    const yy = y[i], bb = cb[i] - 128, rr = cr[i] - 128
    out[i * 3] = clamp(yy + 1.402 * rr)
    out[i * 3 + 1] = clamp(yy - 0.344136 * bb - 0.714136 * rr)
    out[i * 3 + 2] = clamp(yy + 1.772 * bb)
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
}

/**
 * { buf, width, height, from: { width, height }, scale } — `size`: 'original' | '2k' | '4k'.
 * A picture already at least as big as the choice is not enlarged (and never made smaller).
 */
export async function refineFaithful(input, { size = 'original', params = PARAMS } = {}) {
  const p = { ...PARAMS, ...params }
  const base = await sharp(input).rotate().toColourspace('srgb').removeAlpha().png({ compressionLevel: 0 }).toBuffer()
  const m = await sharp(base).metadata()
  const long = Math.max(m.width, m.height)
  const target = SIZES[size] ?? 0
  const scale = target > long ? target / long : 1
  const soft = await softenColour(base, p)
  let img = sharp(soft)
  if (scale > 1) img = img.resize({ width: Math.round(m.width * scale), height: Math.round(m.height * scale), kernel: 'lanczos3', fit: 'fill' })
  // The mask is scaled to the enlargement: the same look at any size.
  if (p.sharpAmount) img = img.sharpen({ sigma: p.sharpSigma * Math.max(1, Math.sqrt(scale)), m1: p.sharpAmount, m2: p.sharpAmount * 1.5 })
  const buf = await img.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: scale <= 1 }).toBuffer()
  const o = await sharp(buf).metadata()
  return { buf, width: o.width, height: o.height, from: { width: m.width, height: m.height }, scale }
}
