/**
 * photoEnhanceGemini.js — technical-only image enhancement via Gemini.
 *
 * Prompt is strictly technical (sharpness, noise, exposure, colour).
 * It forbids altering subjects, features, or background — Gemini is
 * used as a retoucher, not a re-generator.
 */

import fs from 'fs/promises'
import path from 'path'
import { GoogleGenAI } from '@google/genai'

const PROMPT =
  'Enhance the quality of this image without altering, replacing, or ' +
  'adding any subjects, facial features, or background elements. Keep ' +
  'the composition, identity, and details completely faithful to the ' +
  'original. Only apply technical adjustments: increase sharpness and ' +
  'clarity, reduce noise and compression artifacts, balance exposure, ' +
  'optimize dynamic range, and correct color accuracy for a clean, ' +
  'natural, high-resolution look.'

// Fields whose uploads should automatically trigger enhancement
export const ENHANCED_FIELDS = new Set([
  'Enhanced Photo',
  'Enhanced Full Body Photo',
])

let _ai = null
function getAI() {
  if (_ai) return _ai
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set in .env')
  _ai = new GoogleGenAI({ apiKey: key })
  return _ai
}

/**
 * Enhance a photo with Gemini. Writes the output to a new path and
 * returns { outputPath, model, bytes }.
 *
 * Throws if GEMINI_API_KEY is missing or Gemini returns no image.
 */
export async function enhancePhoto(inputPath, outputPath) {
  const ai = getAI()
  const buf = await fs.readFile(inputPath)
  const base64 = buf.toString('base64')
  const lower = inputPath.toLowerCase()
  const mimeType = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg'

  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.6-flash-image-preview'

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
    config: {
      // Only ask for the image back — no text explanation
      responseModalities: ['IMAGE'],
    },
  })

  const parts = response?.candidates?.[0]?.content?.parts || []
  const imagePart = parts.find(p => p?.inlineData?.data)
  if (!imagePart) {
    throw new Error('Gemini returned no image (check model name + account quota)')
  }

  const outBuf = Buffer.from(imagePart.inlineData.data, 'base64')
  await fs.writeFile(outputPath, outBuf)
  return { outputPath, model, bytes: outBuf.length }
}