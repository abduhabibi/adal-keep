/**
 * tables.js — which tables go between the agency's PCs, and which stay on
 * each PC.
 *
 * Copied: everything a person makes or changes (profiles, their fields and
 * files, CVs, accounts, notes, runs asked for, settings …) and the two tables
 * of the copying itself that all PCs share (sync_pcs: the PCs and their keys;
 * sync_role: who is the main PC, the licence).
 * Each PC's own: its work queues (ingest_queue: the scans it reads itself),
 * bookkeeping (the online copy's state, the downloads folder, usage counts,
 * the tutor), its licence row, the AI chat history, and the copying's own log.
 * A table not named in either list is copied when it has a one-column key
 * (a new table from a later version is copied by default).
 */
export const LOCAL = new Set([
  'activity_log', 'ai_conversations', 'ai_messages', 'cloud_sync', 'downloads_state', 'feature_use',
  'ingest_queue', 'knowledge_base', 'license', 'tutor_days', 'tutor_prefs', 'tutor_usage', 'updates',
  'knex_migrations', 'knex_migrations_lock', 'sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4',
  'sync_log', 'sync_clock', 'sync_dirty', 'sync_ctl', 'sync_vector', 'sync_pending', 'sync_alias',
  'sync_docs', 'sync_meta', 'sync_conflicts', 'sync_peers',
])

/** Shared by every PC of the agency (copied like the rest). */
export const SHARED_SYNC_TABLES = ['sync_pcs', 'sync_role']

/** Copied tables whose ids are made by ids.js (all with an integer id). More are found at start. */
export const ID_TABLES = [
  'profiles', 'profile_fields', 'files', 'brokers', 'field_templates', 'checklists', 'checklist_profiles',
  'checklist_cells', 'cv_templates', 'cv_headers', 'generated_cvs', 'automation_queue', 'profile_automations',
  'lmis_accounts', 'musaned_accounts', 'visa_accounts', 'tasheer_accounts', 'insurance_accounts', 'notes',
  'profile_days', 'quick_links', 'settings', 'tasks', 'trash', 'whatsapp_agents', 'whatsapp_sends',
  'companies', 'branches', 'users', 'notifications', 'document_verifications',
]

/**
 * Columns that point at a row of a table that can be merged (two PCs made the
 * same girl, the same setting …, merge.js): when rows merge, these follow.
 */
export const POINTERS = {
  profile_id: 'profiles',
  field_template_id: 'field_templates',
  profile_field_id: 'profile_fields',
}

/** Columns that name a document in data/SafeStorage (docs.js fetches what a row names). */
export const DOC_COLUMNS = {
  files: ['path'],
  generated_cvs: ['pdf_path', 'filename'],
  profiles: ['photo_path', 'full_body_photo_path', 'passport_file'],
  cv_templates: ['logo_path', 'header_path', 'footer_path'],
  cv_headers: ['path'],
  tasks: ['source_file'],
}

export const isInternal = (t) => /^sync_/.test(t) && !SHARED_SYNC_TABLES.includes(t)
