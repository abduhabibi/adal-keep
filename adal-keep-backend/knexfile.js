import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { openRows } from './src/services/accountVault.js'
dotenv.config()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLITE_FILE = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, 'data.sqlite')
const connection = { filename: SQLITE_FILE }
export default {
  development: {
    client: 'sqlite3',
    connection,
    useNullAsDefault: true,
    postProcessResponse: openRows,
    // One connection (SQLite): on a swamped PC a request waits up to 2 minutes for it instead of failing.
    pool: {
      acquireTimeoutMillis: 120000,
      afterCreate(conn, done) {
        conn.run('PRAGMA journal_mode = WAL;')
        conn.run('PRAGMA busy_timeout = 8000;')
        conn.run('PRAGMA synchronous = NORMAL;')
        conn.run('PRAGMA secure_delete = ON;')
        done(null, conn)
      }
    },
    migrations: { directory: './src/migrations', tableName: 'knex_migrations' },
    seeds: { directory: './src/seeds' },
  },
  production: {
    client: 'sqlite3',
    connection,
    useNullAsDefault: true,
    postProcessResponse: openRows,
    migrations: { directory: './src/migrations', tableName: 'knex_migrations' },
  },
}
