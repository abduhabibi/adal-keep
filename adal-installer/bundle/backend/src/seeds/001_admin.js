import bcrypt from 'bcryptjs'

export async function seed(knex) {
  await knex('developer_access').del()
  await knex('users').del()
  await knex('branches').del()

  const [branch] = await knex('branches')
    .insert({ name: 'Main Branch', is_primary: true })
    .returning('*')

  const passwordHash = await bcrypt.hash('admin123', 10)
  await knex('users').insert({
    branch_id: branch.id,
    role: 'admin',
    username: 'admin',
    password_hash: passwordHash,
    full_name: 'System Admin',
    is_verified: true,
    is_active: true,
  })

  const devToken = process.env.DEVELOPER_BYPASS_TOKEN || 'dev-secret-token-change-me'
  const devTokenHash = await bcrypt.hash(devToken, 10)
  await knex('developer_access').insert({ token_hash: devTokenHash })
}
