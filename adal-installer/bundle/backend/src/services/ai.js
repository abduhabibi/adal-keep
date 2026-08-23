import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

// Confirmed working free models (non-reasoning, fast)
const FAST_MODELS = [
  'inclusionai/ling-3.0-flash:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-nano-9b-v2:free'
]

const VISION_MODELS = [
  'nvidia/nemotron-nano-12b-2-vl:free',
  'nvidia/nemotron-3-nano-omni:free'
]

class AIService {
  constructor() {
    if (!OPENROUTER_API_KEY) {
      console.warn('⚠️ OPENROUTER_API_KEY not found in .env')
    }
  }

  async chat(messages, options = {}) {
    const modelsToTry = options.models || FAST_MODELS
    const maxTokens = options.maxTokens || 2048
    const temperature = options.temperature || 0.7

    for (const model of modelsToTry) {
      try {
        const response = await axios.post(
          `${OPENROUTER_BASE_URL}/chat/completions`,
          {
            model,
            messages,
            temperature,
            max_tokens: maxTokens
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://adal-keep.com',
              'X-Title': 'Adal Keep'
            },
            timeout: 15000
          }
        )

        const content = response.data.choices[0]?.message?.content
        if (!content) continue

        return {
          success: true,
          message: content,
          model,
          usage: response.data.usage
        }
      } catch (error) {
        console.warn(`Model ${model} failed: ${error.response?.data?.error?.message || error.message}`)
        continue
      }
    }

    return {
      success: false,
      error: 'All AI models unavailable. Please try again later.'
    }
  }

  async analyzeImage(imageUrl, prompt = 'Describe this image in detail') {
    for (const model of VISION_MODELS) {
      try {
        const response = await axios.post(
          `${OPENROUTER_BASE_URL}/chat/completions`,
          {
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: imageUrl } }
                ]
              }
            ],
            max_tokens: 2048
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://adal-keep.com',
              'X-Title': 'Adal Keep'
            },
            timeout: 30000
          }
        )

        const content = response.data.choices[0]?.message?.content
        if (!content) continue

        return {
          success: true,
          message: content,
          model,
          usage: response.data.usage
        }
      } catch (error) {
        console.warn(`Vision model ${model} failed: ${error.response?.data?.error?.message || error.message}`)
        continue
      }
    }

    return {
      success: false,
      error: 'Vision analysis unavailable. Please try again later.'
    }
  }

  async chatAmharic(userMessage, knowledgeBase = []) {
    const systemPrompt = `You are Adal Keep AI assistant for an Ethiopian document management agency.
Always respond in Amharic. Be concise and professional.

Agency knowledge:
${knowledgeBase.length > 0 ? knowledgeBase.join('\n') : 'No additional knowledge loaded yet.'}

If unsure, say: "ይቅርታ፣ ስለዚህ ጉዳይ መረጃ የለኝም።"`

    return await this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ])
  }
}

export default new AIService()  