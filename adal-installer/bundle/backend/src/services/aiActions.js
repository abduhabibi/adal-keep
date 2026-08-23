import aiService from './ai.js'

class AIActions {
  constructor(db) {
    this.db = db
  }

  /**
   * Process user message and detect if AI should perform an action.
   * Returns { suggestion, pendingAction } where pendingAction requires confirmation.
   */
  async processMessage(message, context = {}) {
    const toolsPrompt = `You are an AI assistant for an Ethiopian document agency.
You can perform these actions by responding with a JSON block:

ACTIONS AVAILABLE:
1. create_profile - Create a new client profile
2. create_task - Create a task
3. create_checklist - Create a checklist for a profile
4. assign_broker - Assign a profile to a broker
5. upload_file_note - Note that a file was detected/uploaded

RESPONSE FORMAT:
Always respond in Amharic first with a brief explanation.
Then, if an action is needed, include a JSON code block like this:
\`\`\`action
{"type":"create_profile","data":{"full_name":"...","passport_number":"...","nationality":"...","phone":"...","broker_id":null}}
\`\`\`

If no action is needed, just respond in Amharic normally.
NEVER execute without showing the action JSON first.
Current context: ${JSON.stringify(context)}`

    const result = await aiService.chat([
      { role: 'system', content: toolsPrompt },
      { role: 'user', content: message }
    ])

    if (!result.success) {
      return { suggestion: null, pendingAction: null, error: 'AI unavailable' }
    }

    const response = result.message
    const actionMatch = response.match(/```action\s*\n?([\s\S]*?)\n?```/)

    let pendingAction = null
    let suggestion = response

    if (actionMatch) {
      try {
        pendingAction = JSON.parse(actionMatch[1].trim())
        // Remove the JSON block from the display text
        suggestion = response.replace(/```action[\s\S]*?```/, '').trim()
      } catch {
        // Invalid JSON, treat as normal response
      }
    }

    return { suggestion, pendingAction, model: result.model }
  }

  /**
   * Execute a confirmed action
   */
  async executeAction(action, confirmedBy) {
    const { type, data } = action

    switch (type) {
      case 'create_profile': {
        const [id] = await this.db('profiles').insert({
          full_name: data.full_name || 'Unknown',
          passport_number: data.passport_number || null,
          nationality: data.nationality || 'Ethiopian',
          phone_number: data.phone || null,
          broker_id: data.broker_id || null,
          status: 'pending_verification',
          is_ai_created: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        return { success: true, type, id, message: `ፕሮፋይል ተፈጥሯል: ${data.full_name} (ID: ${id})` }
      }

      case 'create_task': {
        const [id] = await this.db('tasks').insert({
          title: data.title || 'AI Generated Task',
          description: data.description || '',
          priority: data.priority || 'medium',
          status: 'todo',
          due_date: data.due_date || null,
          is_ai_created: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        return { success: true, type, id, message: `ተግባር ተፈጥሯል: ${data.title}` }
      }

      case 'create_checklist': {
        const [id] = await this.db('checklists').insert({
          name: data.name || 'AI Checklist',
          profile_id: data.profile_id || null,
          items: JSON.stringify(data.items || []),
          created_at: new Date().toISOString()
        })
        return { success: true, type, id, message: `የክትትል ዝርዝር ተፈጥሯል: ${data.name}` }
      }

      case 'assign_broker': {
        await this.db('profiles')
          .where('id', data.profile_id)
          .update({ broker_id: data.broker_id, updated_at: new Date().toISOString() })
        return { success: true, type, message: `ፕሮፋይል ለደላል ተመድቧል` }
      }

      default:
        return { success: false, message: 'Unknown action type' }
    }
  }

  /**
   * Process uploaded file with vision AI to extract passport/document data
   */
  async processDocumentImage(imageUrl, filename) {
    const prompt = `Analyze this document image. Extract ALL visible information.
Return ONLY valid JSON:
{
  "document_type": "passport|id_card|medical|contract|visa|other",
  "extracted_data": {
    "full_name": "",
    "passport_number": "",
    "nationality": "",
    "date_of_birth": "",
    "expiry_date": "",
    "phone": "",
    "any_other_fields": {}
  },
  "confidence": 0.0-1.0,
  "notes": "any observations in Amharic"
}`

    const result = await aiService.analyzeImage(imageUrl, prompt)

    if (!result.success) {
      return { success: false, error: 'Vision analysis failed' }
    }

    try {
      const jsonMatch = result.message.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { success: false, error: 'Could not parse vision response' }

      const extracted = JSON.parse(jsonMatch[0])

      // Generate confirmation action
      const pendingAction = {
        type: 'create_profile',
        data: {
          full_name: extracted.extracted_data?.full_name || filename,
          passport_number: extracted.extracted_data?.passport_number || null,
          nationality: extracted.extracted_data?.nationality || 'Ethiopian',
          phone: extracted.extracted_data?.phone || null,
          source_file: filename,
          document_type: extracted.document_type
        },
        vision_confidence: extracted.confidence,
        vision_notes: extracted.notes
      }

      return {
        success: true,
        extracted,
        pendingAction,
        message: `📄 ሰነድ ተተነትኗል (${extracted.document_type})\nእርግጠኝነት: ${(extracted.confidence * 100).toFixed(0)}%\n${extracted.notes || ''}`
      }
    } catch {
      return { success: false, error: 'Failed to parse extracted data' }
    }
  }
}

export default AIActions
