import aiService from './ai.js'

class WorkflowLearner {
  constructor(db) {
    this.db = db
  }

  async analyzeRecentActivity(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 3600000).toISOString()
    const events = await this.db('activity_log')
      .where('created_at', '>', cutoff)
      .orderBy('id', 'asc')

    if (events.length < 5) {
      return { success: false, message: 'Not enough events to analyze', workflows_found: 0 }
    }

    const byClient = {}
    for (const ev of events) {
      if (!byClient[ev.client_id]) byClient[ev.client_id] = []
      byClient[ev.client_id].push(ev)
    }

    const workflows = []

    for (const [clientId, clientEvents] of Object.entries(byClient)) {
      const summary = clientEvents.map(e =>
        `[${e.created_at}] ${e.event_type}: ${e.event_data || '{}'}`
      ).join('\n')

      const prompt = `Analyze these employee activity logs and extract the workflow pattern.
Return ONLY valid JSON:
{
  "workflow_name": "short name",
  "steps": ["step 1", "step 2"],
  "key_files": ["file types involved"],
  "estimated_time_minutes": 0,
  "anomalies": ["anything unusual"]
}

Activity log:
${summary}`

      try {
        const result = await aiService.chat([
          { role: 'system', content: 'You are a workflow analyst. Extract patterns from activity logs. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt }
        ])

        if (result.success) {
          const jsonMatch = result.message.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const workflow = JSON.parse(jsonMatch[0])
            workflow.client_id = clientId
            workflow.analyzed_at = new Date().toISOString()
            workflow.source_events_count = clientEvents.length
            workflows.push(workflow)

            await this.db('knowledge_base').insert({
              content: JSON.stringify(workflow),
              category: 'learned_workflow',
              is_active: true,
              created_at: new Date().toISOString()
            })
          }
        }
      } catch (e) {
        console.warn(`Workflow parse failed for ${clientId}:`, e.message)
      }
    }

    return { success: true, workflows_found: workflows.length, workflows }
  }

  async getLearnedWorkflows() {
    const rows = await this.db('knowledge_base')
      .where('category', 'learned_workflow')
      .where('is_active', true)
      .orderBy('created_at', 'desc')

    return rows.map(r => {
      try { return JSON.parse(r.content) } catch { return null }
    }).filter(Boolean)
  }

  async suggestNextStep(clientId, currentContext) {
    const workflows = await this.getLearnedWorkflows()
    if (workflows.length === 0) return null

    const prompt = `Based on these learned workflows:
${JSON.stringify(workflows.slice(0, 5))}

And current context: ${JSON.stringify(currentContext)}

What should the employee do next? Respond in Amharic, one short sentence.`

    const result = await aiService.chatAmharic(prompt)
    return result.success ? result.message : null
  }
}

export default WorkflowLearner
