import { grokChat, models } from './grokClient.js'

export async function processAIQuery(query, companyId, db) {
  const systemPrompt = `You are "Adal", a helpful Ethiopian document processing assistant.
You ONLY speak Amharic. Never use English or any other language.
Your responses must be concise, helpful, and entirely in Amharic.`

  const result = await grokChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(query || '') }
    ],
    { model: models.text, temperature: 0.3, maxTokens: 1024 }
  )

  if (!result.success) {
    return {
      result: 'AI ጥያቄን ማስተናገድ አልተቻለም። እባክዎ እንደገና ይሞክሩ',
      action: 'error'
    }
  }
  return { result: result.message, action: 'query' }
}

export default { processAIQuery }
