/**
 * deepseekClient.js — thin OpenAI-compatible client for DeepSeek.
 *
 * Exposes the same shape as the old grokClient:
 *   import { deepseek, models } from './deepseekClient.js'
 *   deepseek.chat.completions.create({ model: models.vision, ... })
 *
 * Env:
 *   DEEPSEEK_API_KEY       required
 *   DEEPSEEK_BASE_URL      optional, default https://api.deepseek.com/v1
 *   DEEPSEEK_VISION_MODEL  optional, default deepseek-vl2
 *   DEEPSEEK_TEXT_MODEL    optional, default deepseek-chat
 */
import OpenAI from 'openai'

const apiKey = process.env.DEEPSEEK_API_KEY || ''

export const deepseek = apiKey
  ? new OpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    })
  : null

export const models = {
  vision: process.env.DEEPSEEK_VISION_MODEL || 'deepseek-vl2',
  text:   process.env.DEEPSEEK_TEXT_MODEL   || 'deepseek-chat',
}

export default { deepseek, models }