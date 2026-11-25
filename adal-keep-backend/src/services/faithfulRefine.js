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
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { verifyModel, modelFile, esrganOn } from './esrganModel.js'

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

// ---- the AI way: Real-ESRGAN, blended in at a small strength (owner, 2026-11-25: "a very little bit cleaner") ----
// X = (1 - a) * plain + a * AI, where plain is the faithful way above and AI is the network's x4 picture brought to the same
// size. Nothing else is done to the AI picture: no brightness, gamma, saturation or normalise. The blend must pass two checks,
// measured on the picture shrunk back to the input's size:
//   - it must still match the input: PSNR >= LIMIT_DB (the plain way gives 37.5 dB on the test portrait; the old Refine, which
//     visibly changed her, gave 31.7; 34 sits between, closer to the plain way)
//   - her colours must not move: the mean colour shift <= LIMIT_SHIFT (plain 0.4; the old Refine 5.5)
// Over a limit the blend is lowered one step (30 % -> 20 % -> 10 %), then the plain way is used. Only a picture up to
// SR_INPUT_MAX px long goes to the network (a bigger one is sharp enough already, and x4 of it would be slow for nothing).
export const LIMIT_DB = 34
export const LIMIT_SHIFT = 1.0
export const STRENGTHS = [0.3, 0.2, 0.1]
export const SR_INPUT_MAX = 1400
export const ESRGAN_TIMEOUT_MS = 3 * 60_000

const WORKER = fileURLToPath(new URL('./esrganWorker.mjs', import.meta.url))
/** The real upscaler: the network in its own low-priority process, killed after the time limit. { raw, w, h } */
export function esrganUpscale(png, { model = modelFile(), timeoutMs = ESRGAN_TIMEOUT_MS } = {}) {
  const id = crypto.randomBytes(6).toString('hex')
  const src = path.join(os.tmpdir(), `adal-sr-${id}.png`), out = path.join(os.tmpdir(), `adal-sr-${id}.raw`)
  fs.writeFileSync(src, png)
  return new Promise((resolve, reject) => {
    const threads = Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1))
    const child = fork(WORKER, [JSON.stringify({ src, out, model, threads })], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    try { os.setPriority(child.pid, 10) } catch {}
    const clean = () => { for (const f of [src, out]) { try { fs.unlinkSync(f) } catch {} } }
    const timer = setTimeout(() => { child.kill(); clean(); reject(new Error('the AI took longer than 3 minutes and was stopped')) }, timeoutMs)
    let answer = null
    child.on('message', (m) => { answer = m })
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        if (!answer?.ok) return reject(new Error(answer?.error || 'the AI process ended without an answer'))
        resolve({ raw: fs.readFileSync(out), w: answer.w, h: answer.h })
      } catch (e) { reject(e) } finally { clean() }
    })
    child.on('error', (e) => { clearTimeout(timer); clean(); reject(e) })
  })
}

const meanOf = (raw) => { const m = [0, 0, 0], n = raw.length / 3; for (let i = 0; i < raw.length; i += 3) { m[0] += raw[i]; m[1] += raw[i + 1]; m[2] += raw[i + 2] } return m.map(v => v / n) }
function psnrRaw(a, b) {
  let e = 0; const n = a.length / 3
  for (let i = 0; i < a.length; i += 3) { const ya = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2], yb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2]; e += (ya - yb) ** 2 }
  e /= n; return e === 0 ? 99 : 10 * Math.log10(255 * 255 / e)
}
/** How far a result is from the input once shrunk back to it: { db, shift }. */
export async function check(resultRaw, rw, rh, inputRaw, iw, ih) {
  const back = rw === iw && rh === ih ? resultRaw : await sharp(resultRaw, { raw: { width: rw, height: rh, channels: 3 } }).resize({ width: iw, height: ih, kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer()
  const mi = meanOf(inputRaw), mr = meanOf(back)
  return { db: psnrRaw(back, inputRaw), shift: Math.max(...mi.map((v, i) => Math.abs(v - mr[i]))) }
}

/**
 * { buf, width, height, from, scale, engine: 'plain' | 'esrgan', blend, check, note }.
 * `size`: 'original' | '2k' | '4k'. `engine`: 'plain' (default) | 'esrgan' (needs ADAL_REFINE_ESRGAN=1 and the exact model file;
 * otherwise the plain way is used and `note` says why). `upscale` is a stand-in for the network (tests).
 * A picture already at least as big as the choice is not enlarged (and never made smaller).
 */
export async function refineFaithful(input, { size = 'original', params = PARAMS, engine = 'plain', upscale = null, strengths = STRENGTHS } = {}) {
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
  const encode = (i) => i.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: scale <= 1 }).toBuffer()
  const done = async (buf, extra) => { const o = await sharp(buf).metadata(); return { buf, width: o.width, height: o.height, from: { width: m.width, height: m.height }, scale, engine: 'plain', blend: 0, check: null, note: '', ...extra } }

  let note = ''
  if (engine === 'esrgan') {
    const up = upscale || (() => esrganUpscale(base))
    if (!upscale && !esrganOn()) note = 'the AI way is turned off on this PC (ADAL_REFINE_ESRGAN)'
    else if (!upscale && !verifyModel().ok) note = `the AI way is not used: ${verifyModel().reason}`
    else if (long > SR_INPUT_MAX) note = `already ${long}px: the AI way is not used`
    else {
      try {
        const net = await up(base)
        const W = Math.round(m.width * scale), H = Math.round(m.height * scale)
        const plainRaw = await img.clone().raw().toBuffer()
        const aiRaw = await sharp(net.raw, { raw: { width: net.w, height: net.h, channels: 3 } }).resize({ width: W, height: H, kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer()
        const inputRaw = await sharp(base).raw().toBuffer()
        let tried = ''
        for (const a of strengths) {
          const mix = Buffer.alloc(plainRaw.length)
          for (let i = 0; i < mix.length; i++) mix[i] = Math.round(plainRaw[i] + a * (aiRaw[i] - plainRaw[i]))
          const c = await check(mix, W, H, inputRaw, m.width, m.height)
          if (c.db >= LIMIT_DB && c.shift <= LIMIT_SHIFT) {
            const buf = await encode(sharp(mix, { raw: { width: W, height: H, channels: 3 } }))
            return done(buf, { engine: 'esrgan', blend: a, check: { db: +c.db.toFixed(2), shift: +c.shift.toFixed(2) }, note: tried })
          }
          tried += `AI at ${Math.round(a * 100)}% went over the limit (${c.db.toFixed(1)} dB, colour ${c.shift.toFixed(1)}); `
        }
        note = tried + 'the plain way is used'
      } catch (e) { note = `the AI way failed (${e.message}); the plain way is used` }
    }
  }
  return done(await encode(img), { note })
}
