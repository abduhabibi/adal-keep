import OpenAI from 'openai'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Always load adal-keep-backend/.env regardless of process cwd
dotenv.config({ path: path.join(__dirname, '../../.env') })
dotenv.config() // fallback cwd

const apiKey = String(process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim()
const baseURL = String(process.env.XAI_BASE_URL || 'https://api.x.ai/v1').trim()
const TEXT_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning'
const VISION_MODEL = process.env.XAI_VISION_MODEL || 'grok-4.20-non-reasoning'

if (!apiKey) {
  console.warn('[Grok] XAI_API_KEY is empty after loading .env')
} else {
  console.log('[Grok] key loaded, len=', apiKey.length, 'model=', TEXT_MODEL)
}

export const grok = apiKey
  ? new OpenAI({
      apiKey,
      baseURL,
      timeout: 120_000,
      maxRetries: 3
    })
  : null

export const models = { text: TEXT_MODEL, vision: VISION_MODEL }

export async function grokChat(messages, options = {}) {
  if (!grok) return { success: false, error: 'No XAI_API_KEY' }
  try {
    const res = await grok.chat.completions.create({
      model: options.model || TEXT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 512
    })
    return {
      success: true,
      message: res.choices?.[0]?.message?.content || '',
      model: res.model || TEXT_MODEL
    }
  } catch (err) {
    const detail = [
      err?.message,
      err?.code,
      err?.cause?.message,
      err?.status,
      err?.response?.status
    ].filter(Boolean).join(' | ')
    console.error('[Grok chat] Connection failed:', detail)
    return { 
      success: false, 
      error: detail || 'Connection error',
      suggestion: 'ይቅርታ፣ አሁን ማገልገል አልቻልኩም። በጥቂት ሰከንድ ውስጥ እንደገና ይሞክሩ።' 
    }
  }
}

export async function grokVision({ prompt, base64, mimeType = 'image/jpeg', temperature = 0.1, json = false }) {
  if (!grok) return { success: false, error: 'No XAI_API_KEY' }
  try {
    const res = await grok.chat.completions.create({
      model: VISION_MODEL,
      temperature,
      max_tokens: json ? 800 : 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
          { type: 'text', text: prompt }
        ]
      }]
    })
    const text = res.choices?.[0]?.message?.content || ''
    if (json) {
      try {
        const m = text.match(/\{[\s\S]*\}/)
        return { success: true, data: m ? JSON.parse(m[0]) : null, raw: text, model: VISION_MODEL }
      } catch {
        return { success: true, data: null, raw: text, model: VISION_MODEL }
      }
    }
    return { success: true, message: text, model: VISION_MODEL }
  } catch (err) {
    const detail = err?.message || String(err)
    console.error('[Grok vision]', detail)
    return { success: false, error: detail }
  }
}

export default { grok, models, grokChat, grokVision }
