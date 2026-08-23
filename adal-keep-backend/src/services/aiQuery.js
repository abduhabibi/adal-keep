import axios from 'axios'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = 'gemini-3.6-flash'

export async function processAIQuery(query, companyId, db) {
  const systemPrompt = `You are "Adal", a helpful Ethiopian document processing assistant.
You ONLY speak Amharic. Never use English or any other language.
Your responses must be concise, helpful, and entirely in Amharic.`

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: `${systemPrompt}\n\nUser query: ${query}` }]
        }]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      }
    )
    const result = res.data.candidates?.[0]?.content?.parts?.[0]?.text || 'ምላሽ ማግኘት አልተቻለም'
    return { result, action: 'query' }
  } catch (err) {
    console.error('AI query error:', err.response?.data || err.message)
    return {
      result: 'AI ጥያቄን ማስተናገድ አልተቻለም። እባክዎ እንደገና ይሞክሩ',
      action: 'error'
    }
  }
}
