import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { openRows } from './src/services/accountVault.js'
// New rows get ids no other PC of the agency can make (services/sync/ids.js).
import { SyncClient } from './src/services/sync/ids.js'
import { companionFullOn } from './src/services/sync/index.js'
import { isCompanionInstall } from './src/services/mainPC.js'
// (Only while the copying is switched on: otherwise SQLite's own ids, as before.)
const CLIENT = companionFullOn() || isCompanionInstall() ? SyncClient : 'sqlite3'
dotenv.config()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLITE_FILE = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, 'data.sqlite')
const connection = { filename: SQLITE_FILE }
export default {
  development: {
    client: CLIENT,
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
        // 16 MB of pages kept in memory (the default is 2 MB): the lists every page
        // asks for are read from RAM, not the slow disk. Sorts stay in memory too.
        conn.run('PRAGMA cache_size = -16000;')
        conn.run('PRAGMA temp_store = MEMORY;')
        done(null, conn)
      }
    },
    migrations: { directory: './src/migrations', tableName: 'knex_migrations' },
    seeds: { directory: './src/seeds' },
  },
  production: {
    client: CLIENT,
    connection,
    useNullAsDefault: true,
    postProcessResponse: openRows,
    migrations: { directory: './src/migrations', tableName: 'knex_migrations' },
  },
}
