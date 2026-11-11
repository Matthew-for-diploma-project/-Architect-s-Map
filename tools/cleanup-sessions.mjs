#!/usr/bin/env node
import { createDatabase } from '../src/backend/database.mjs';
import { cleanupExpiredSessions } from '../src/backend/session-cleanup.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node tools/cleanup-sessions.mjs [--test]\nУдаляет до 1000 истёкших сессий. --test требует NODE_ENV=test и TEST_DATABASE_URL.');
  process.exit(0);
}
if (args.length > 1 || (args.length && args[0] !== '--test') ||
    (args.includes('--test') !== (process.env.NODE_ENV === 'test'))) {
  console.error('Для тестовой очистки нужны --test и NODE_ENV=test; обычный запуск — без --test.');
  process.exit(1);
}

let database;
try {
  database = createDatabase();
  const deleted = await cleanupExpiredSessions(database);
  console.log(`Сессии: удалено истёкших ${deleted} (предел 1000 за запуск).`);
} catch (error) {
  console.error(error.code === 'DATABASE_CONFIG_INVALID' ? error.message
    : 'Очистка сессий PostgreSQL не выполнена. Проверьте серверную конфигурацию и БД.');
  process.exitCode = 1;
} finally {
  await database?.close();
}
