/**
 * src/services/ai.js
 *
 * Chat service for the AI assistant. Calls DeepSeek's chat completions
 * endpoint directly. Previously pointed at Grok via grokClient.js, but the
 * XAI key was a placeholder — DeepSeek is the working provider.
 *
 * Interface stays the same: `chat(messages, options)` returns
 *   { success: true,  content: '...' }
 *   { success: false, error: '...' }
 */

import { getSecret } from './secretStore.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'

function getKey() {
  return (
    getSecret('DEEPSEEK_API_KEY') ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  )
}

function normalize(messages) {
  return (messages || []).map(m => ({
    role: m.role === 'model' ? 'assistant' : m.role,
    content: typeof m.content === 'string' ? m.content : String(m.content || ''),
  }))
}

class AIService {
  async chat(messages, options = {}) {
    const key = getKey()
    if (!key) {
      return { success: false, error: 'DEEPSEEK_API_KEY not configured' }
    }

    const normalized = normalize(messages)
    const system = normalized.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const rest = normalized.filter(m => m.role !== 'system')
    while (rest.length && rest[0].role === 'assistant') rest.shift()

    const payload = []
    if (system) payload.push({ role: 'system', content: system })
    payload.push(...rest)
    if (!payload.length) {
      return { success: false, error: 'Empty conversation' }
    }

    const model = options.model || process.env.AI_MODEL || 'deepseek-chat'
    const body = {
      model,
      messages: payload,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      stream: false,
    }

    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ac = new AbortController()
      const to = setTimeout(() => ac.abort(), 90000)
      try {
        const res = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        })
        clearTimeout(to)

        if (!res.ok) {
          const text = await res.text()
          return { success: false, error: `DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}` }
        }

        const data = await res.json()
        const content = data.choices?.[0]?.message?.content || ''
        if (!content) {
          return {
            success: false,
            error: 'DeepSeek returned empty content',
            suggestion: 'ምላሽ ባዶ ነበር። በድጋሚ ይሞክሩ።',
          }
        }
        console.log(`[AI] chat ✓ ${content.length} chars back`)
        return {
          success: true,
          content,           // kept for the vision pipeline's expectations
          message: content,  // what aiActions.js reads
          model: data.model || model,
        }
      } catch (e) {
        clearTimeout(to)
        lastErr = e
        const code = e.cause?.code || e.name || 'unknown'
        console.warn(`[AI] chat attempt ${attempt} failed (${code}): ${e.message}`)
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }
    const code = lastErr?.cause?.code || lastErr?.message || 'unknown'
    console.error('[AI] all attempts failed:', code)
    return {
      success: false,
      error: `DeepSeek fetch failed: ${code}`,
      suggestion: 'ይቅርታ፣ አሁን ማገልገል አልቻልኩም። (' + code + ')',
    }
  }
}

export default new AIService()