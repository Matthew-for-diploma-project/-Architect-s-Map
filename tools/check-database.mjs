#!/usr/bin/env node
import { createDatabase } from '../src/backend/database.mjs';

let database;
try {
  database = createDatabase();
  await database.checkConnection();
  console.log('PostgreSQL: соединение установлено.');
} catch (error) {
  // Only our safe errors cross this CLI boundary.
  console.error(error.code === 'DATABASE_CONFIG_INVALID' ? error.message : 'PostgreSQL недоступна. Проверьте запуск БД и серверные настройки подключения.');
  process.exitCode = 1;
} finally {
  if (database) {
    await database.close();
    console.log('PostgreSQL: пул закрыт.');
  }
}
