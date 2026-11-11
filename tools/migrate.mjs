#!/usr/bin/env node
import { createDatabase } from '../src/backend/database.mjs';
import { applyMigrations } from '../src/backend/migrations.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node tools/migrate.mjs [--test]\nОбычная БД: DATABASE_URL. --test требует NODE_ENV=test и TEST_DATABASE_URL.');
  process.exit(0);
}
if (args.length > 1 || (args.length && args[0] !== '--test') ||
    (args.includes('--test') !== (process.env.NODE_ENV === 'test'))) {
  console.error('Для тестовых миграций нужны --test и NODE_ENV=test; обычный запуск — без --test.');
  process.exit(1);
}

let database;
try {
  database = createDatabase();
  const result = await applyMigrations(database.pool);
  console.log(`Миграции: применено ${result.applied.length}, уже применено ${result.skipped.length}.`);
} catch (error) {
  console.error(['DATABASE_CONFIG_INVALID', 'MIGRATION_FAILED'].includes(error.code) ? error.message : 'Миграции PostgreSQL не выполнены. Проверьте серверную конфигурацию и БД.');
  process.exitCode = 1;
} finally {
  await database?.close();
}
