/**
 * Wakala (the agency fee the Saudi office pays on Musaned). The "Check if
 * chosen" run and the contract scan read Musaned's Employment Requests list,
 * whose Payment column says Paid or Unpaid (profiles.musaned_payment).
 *
 * Unpaid → the agent who chose her (the WhatsApp agent whose Musaned office
 * matches the office that chose her) gets asked to pay: a call on the PC and
 * the phones whose tap opens that agent's WhatsApp chat with the request
 * already written in Arabic. Asked once every 3 days at most.
 */
import { officeMatches } from './whatsapp.js'

const AGAIN = 3 * 86400000

export const isPaid = (p) => /^paid$/i.test(String(p?.musaned_payment || '').trim())
export const isUnpaid = (p) => /^unpaid$/i.test(String(p?.musaned_payment || '').trim())

export function askText(p) {
  return `السلام عليكم ورحمة الله وبركاته،\n` +
    `نرجو منكم التكرم بسداد رسوم الوكالة للعاملة ${p.full_name}` +
    `${p.passport_number ? ` (جواز رقم ${p.passport_number})` : ''}` +
    `${p.contract_number ? ` – عقد رقم ${p.contract_number}` : ''} على منصة مساند، ` +
    `حتى نتمكن من استكمال إجراءات السفر.\nشاكرين لكم تعاونكم 🌹`
}

/** The agent's chat as a link that opens WhatsApp (app on a phone, WhatsApp Web on a PC). */
export function chatLink(chatId, text) {
  const num = String(chatId || '').match(/^(\d{8,15})@c\.us$/)?.[1]
  const t = encodeURIComponent(text)
  return num ? `https://api.whatsapp.com/send?phone=${num}&text=${t}` : `https://web.whatsapp.com/`
}

/** The WhatsApp agent who chose her: by office name, else the one her CV went to as "chosen here". */
export async function agentFor(db, p) {
  const agents = await db('whatsapp_agents').catch(() => [])
  const byOffice = agents.find(a => officeMatches(a.musaned_office, p.musaned_pro))
  if (byOffice) return byOffice
  const s = await db('whatsapp_sends').where({ profile_id: p.id, status: 'chosen_here' }).first().catch(() => null)
  return s ? agents.find(a => a.id === s.agent_id) || null : null
}

export async function askToPay(db, profileId, { force = false } = {}) {
  const p = await db('profiles').where('id', profileId).first()
  if (!p || !p.chosen_at || !isUnpaid(p)) return { asked: false, why: 'not unpaid' }
  const title = `💰 Wakala not paid: ${p.full_name}`
  if (!force) {
    const last = await db('tasks').where({ profile_id: p.id, title }).orderBy('id', 'desc').first().catch(() => null)
    if (last && Date.now() - new Date(last.created_at).getTime() < AGAIN) return { asked: false, why: 'asked lately' }
  }
  const agent = await agentFor(db, p)
  const text = askText(p)
  const link = agent ? chatLink(agent.chat_id, text) : ''
  const description = agent
    ? `Musaned says the wakala is unpaid (office: ${p.musaned_pro || '?'}). Tap to open ${agent.name}'s WhatsApp with the request written.`
    : `Musaned says the wakala is unpaid (office: ${p.musaned_pro || '?'}). No WhatsApp agent matches this office — set its Musaned office in Settings → Integrations → WhatsApp.`
  const [id] = await db('tasks').insert({
    type: 'automation', title, description, status: 'pending', profile_id: p.id, assigned_to: 1,
    is_ai_created: true, created_at: new Date().toISOString(),
    payload: JSON.stringify({ kind: 'wakala', link, text, agent: agent?.name || null }),
  })
  const taskId = Number(id?.id ?? id) || 0
  // The bell (PC and phone): the link last, shown there as an "Open WhatsApp" button.
  await db('notifications').insert({ type: 'wakala', title, body: link ? `${description}\n${link}` : description, created_day: new Date().toISOString().slice(0, 10) }).catch(() => {})
  import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: taskId, title, description, profile_id: p.id, link, at: Date.now() })).catch(() => {})
  import('./worker.js').then(w => w.beep()).catch(() => {})
  return { asked: true, agent: agent?.name || null, link }
}

/** Every chosen girl Musaned says is unpaid (after a scan of the whole list). */
export async function askAllUnpaid(db) {
  const rows = await db('profiles').whereNotNull('chosen_at').where('musaned_payment', 'like', 'unpaid').select('id').catch(() => [])
  for (const r of rows) await askToPay(db, r.id).catch(e => console.warn('[wakala]', e.message))
}
