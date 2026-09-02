import { grokChat, models } from './grokClient.js'

class AIService {
  async chat(messages, options = {}) {
    const normalized = (messages || []).map(m => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.content
    }))
    const system = normalized.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const rest = normalized.filter(m => m.role !== 'system')
    while (rest.length && rest[0].role === 'assistant') rest.shift()

    const payload = []
    if (system) payload.push({ role: 'system', content: system })
    payload.push(...rest)
    if (!payload.length) return { success: false, error: 'Empty conversation' }

    return grokChat(payload, {
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? 2048,
      model: options.model || models.text
    })
  }
}

export default new AIService()
