/**
 * visionEye.js — DeepSeek Vision wrapper for "where is the button?"
 * questions.
 *
 * Returns coordinates as percentages (0–100) of the image, which the
 * caller converts to viewport pixels. Using percentages avoids any
 * scaling issues between screenshot dimensions and the actual viewport.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEFAULT_MODEL = process.env.AI_VISION_MODEL || 'deepseek-v4-flash-vision-exp'

export async function askEye({ imageBase64, prompt, timeoutMs = 30000 }) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return { ok: false, error: 'DEEPSEEK_API_KEY not set' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        }],
        max_tokens: 300,
        temperature: 0.05,
      }),
    })

    const data = await resp.json()
    const text = data?.choices?.[0]?.message?.content || ''

    // Extract the first JSON object in the reply
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, error: 'no JSON in reply', raw: text.slice(0, 300) }

    try {
      return { ok: true, data: JSON.parse(m[0]), raw: text }
    } catch (e) {
      return { ok: false, error: 'JSON parse failed', raw: text.slice(0, 300) }
    }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}