// Same rule as the backend (routes/tasks.js): notices go stale after a day, finished tasks after a week.
const OPEN = ['pending', 'todo', 'in_progress', 'ongoing']
export const isOpen = (t) => OPEN.includes(t.status)
export function aliveTasks(list, now = Date.now()) {
  if (!Array.isArray(list)) return []
  return list.filter(t => {
    const at = Date.parse(t.created_at) || now
    if (isOpen(t)) return t.type !== 'automation' || now - at < 86400e3
    return now - at < 7 * 86400e3
  })
}
