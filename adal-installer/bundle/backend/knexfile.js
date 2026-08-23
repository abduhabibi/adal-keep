import dotenv from 'dotenv'
dotenv.config()

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
          filename: process.env.SQLITE_PATH || './data.sqlite',
        },
    useNullAsDefault: true,
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
          filename: process.env.SQLITE_PATH || './data.sqlite',
        },
    useNullAsDefault: true,
    migrations: {
      directory: './src/migrations',
      tableName: 'knex_migrations',
    },
  },
}