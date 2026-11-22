/**
 * /api/staff-roles — the roles the admin gives employees (services/staffRoles.js).
 *
 *   GET    /staff-roles          every role, its toggles and how many have it
 *   GET    /staff-roles/me       the employee asking, their role and toggles
 *   POST   /staff-roles          a new role { name, perms }
 *   PUT    /staff-roles/:id      rename it, change its toggles (Admin always has everything)
 *   DELETE /staff-roles/:id      a role no one has (the three ready ones stay)
 *   PUT    /employees/:id/role   give an employee a role { role_id }
 * The changes need "manage staff" (the guard in main.js checks it).
 */
import express from 'express'
import { PERMS, listRoles, cleanPerms, ensureStaffRoles, permsFor } from '../services/staffRoles.js'

const router = express.Router()
const now = () => new Date().toISOString()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const bad = (m) => Object.assign(new Error(m), { status: 400 })

async function nameFree(db, name, id = null) {
  const n = String(name || '').trim().slice(0, 60)
  if (!n) throw bad('The role needs a name')
  const same = (await db('staff_roles').select('id', 'name')).find(r => r.id !== id && r.name.toLowerCase() === n.toLowerCase())
  if (same) throw bad(`There is a role "${same.name}" already`)
  return n
}

router.get('/staff-roles', async (req, res) => {
  try { res.json({ perms: PERMS, roles: await listRoles(req.app.locals.db) }) } catch (e) { fail(res, e) }
})

router.get('/staff-roles/me', async (req, res) => {
  try {
    const { perms, role, user } = await permsFor(req.app.locals.db, req)
    res.json({ perms, role: role ? { id: role.id, name: role.name, preset: role.preset } : null, employee: user ? { id: user.id, name: user.name } : null })
  } catch (e) { fail(res, e) }
})

router.post('/staff-roles', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureStaffRoles(db)
    const name = await nameFree(db, req.body?.name)
    const [id] = await db('staff_roles').insert({ name, preset: null, perms: JSON.stringify(cleanPerms(req.body?.perms)) })
    res.status(201).json({ id: typeof id === 'object' ? id.id : id })
  } catch (e) { fail(res, e) }
})

router.put('/staff-roles/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureStaffRoles(db)
    const id = Number(req.params.id)
    const role = await db('staff_roles').where({ id }).first()
    if (!role) return res.status(404).json({ error: 'No such role' })
    const patch = { updated_at: now() }
    if (req.body?.name != null) patch.name = await nameFree(db, req.body.name, id)
    if (req.body?.perms != null) {
      if (role.preset === 'admin') throw bad('Admin can always do everything')
      patch.perms = JSON.stringify(cleanPerms(req.body.perms))
    }
    await db('staff_roles').where({ id }).update(patch)
    res.json({ success: true })
  } catch (e) { fail(res, e) }
})

router.delete('/staff-roles/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const role = (await listRoles(db)).find(r => r.id === Number(req.params.id))
    if (!role) return res.status(404).json({ error: 'No such role' })
    if (role.preset) throw bad(`${role.name} comes with Adal Keep and stays`)
    if (role.members) throw bad(`${role.members} employee(s) have this role: give them another first`)
    await db('staff_roles').where({ id: role.id }).del()
    res.json({ success: true })
  } catch (e) { fail(res, e) }
})

router.put('/employees/:id/role', async (req, res) => {
  try {
    const db = req.app.locals.db
    const role = (await listRoles(db)).find(r => r.id === Number(req.body?.role_id))
    if (!role) throw bad('Pick a role')
    const user = await db('users').where({ id: Number(req.params.id) }).first()
    if (!user) return res.status(404).json({ error: 'Employee not found' })
    await db('users').where({ id: user.id }).update({ role_id: role.id, updated_at: now() })
    res.json({ success: true, role: { id: role.id, name: role.name } })
  } catch (e) { fail(res, e) }
})

export default router
