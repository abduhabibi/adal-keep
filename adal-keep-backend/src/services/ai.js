import { GoogleGenerativeAI } from '@google/generative-ai'
import dotenv from 'dotenv'
dotenv.config()

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL = 'gemini-3.6-flash'

if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY is missing')
}

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null

class AIService {
  async chat(messages, options = {}) {
    if (!genAI) {
      return { success: false, error: 'Gemini not configured' }
    }

    try {
      const model = genAI.getGenerativeModel({ model: MODEL })
      
      // Convert OpenAI-style messages to Gemini format
      const history = []
      let systemInstruction = ''
      
      for (const msg of messages) {
        if (msg.role === 'system') {
          systemInstruction += msg.content + '\n'
        } else if (msg.role === 'user') {
          history.push({ role: 'user', parts: [{ text: msg.content }] })
        } else if (msg.role === 'assistant') {
          history.push({ role: 'model', parts: [{ text: msg.content }] })
        }
      }

      const chat = model.startChat({
        history: history.slice(0, -1),
        systemInstruction: systemInstruction || undefined,
        generationConfig: {
          temperature: options.temperature || 0.4,
          maxOutputTokens: options.maxTokens || 2048,
        }
      })

      const lastUser = history[history.length - 1]
      const result = await chat.sendMessage(lastUser?.parts?.[0]?.text || '')
      const text = result.response.text()

      return {
        success: true,
        message: text,
        model: MODEL
      }
    } catch (error) {
      console.error('Gemini chat error:', error.message)
      return {
        success: false,
        error: error.message || 'AI service error'
      }
    }
  }

  async analyzeImage(imageUrl, prompt = 'Describe this image in detail') {
    if (!genAI) {
      return { success: false, error: 'Gemini not configured' }
    }

    try {
      const model = genAI.getGenerativeModel({ model: MODEL })
      
      // For now treat imageUrl as base64 or public URL
      // In production you should download the file and send as inlineData
      const result = await model.generateContent([
        prompt,
        // Note: for real vision you need to fetch the image and convert to base64
        // This is a simplified version
      ])
      
      return {
        success: true,
        message: result.response.text(),
        model: MODEL
      }
    } catch (error) {
      console.error('Gemini vision error:', error.message)
      return { success: false, error: error.message }
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
