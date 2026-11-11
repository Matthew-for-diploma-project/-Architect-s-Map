// Node-only pool; it is deliberately outside the Worker build inputs.
import { Pool } from 'pg';
import { readDatabaseConfig } from './database-config.mjs';

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('PostgreSQL недоступна. Проверьте запуск БД и серверные настройки подключения.');
    this.name = 'DatabaseUnavailableError';
    this.code = 'DATABASE_UNAVAILABLE';
  }
}

export function createDatabase({ env = process.env, onError = error => console.error(error.code, error.message) } = {}) {
  const pool = new Pool(readDatabaseConfig(env));
  // pg emits errors for idle clients as well as rejecting active queries.
  // Never forward the original error: it can include credentials or SQL details.
  pool.on('error', () => onError(new DatabaseUnavailableError()));
  let closing;
  return {
    pool,
    async checkConnection() {
      try { await pool.query('SELECT 1'); }
      catch { throw new DatabaseUnavailableError(); }
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
  };
}
