import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
dotenv.config()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLITE_FILE = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, 'data.sqlite')

const isWin = process.platform === 'win32'

export default {
  development: {
    client: isWin ? 'pg' : 'sqlite3',
    connection: isWin
      ? {
          host: process.env.DB_HOST || '127.0.0.1',
          port: process.env.DB_PORT || 5432,
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          database: process.env.DB_NAME || 'adal_keep',
        }
      : {
          filename: SQLITE_FILE,
        },
    useNullAsDefault: true,
    pool: {
      afterCreate(conn, done) {
        conn.run('PRAGMA journal_mode = WAL;')
        conn.run('PRAGMA busy_timeout = 8000;')
        conn.run('PRAGMA synchronous = NORMAL;')
        done(null, conn)
      }
    },
    migrations: {
      directory: './src/migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './src/seeds',
    },
  },
  production: {
    client: isWin ? 'pg' : 'sqlite3',
    connection: isWin
      ? {
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        }
      : {
          filename: SQLITE_FILE,
        },
    useNullAsDefault: true,
    migrations: {
      directory: './src/migrations',
      tableName: 'knex_migrations',
    },
  },
}