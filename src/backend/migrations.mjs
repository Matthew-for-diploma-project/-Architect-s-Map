// Node-only, explicit forward migrations. SQL files are trusted application code.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const lockKeys = [1734700398, 1]; // One migration runner per database, across transactions.

export class MigrationError extends Error {
  constructor(message = 'Миграции PostgreSQL не выполнены. Проверьте подключение и состояние схемы.') {
    super(message);
    this.name = 'MigrationError';
    this.code = 'MIGRATION_FAILED';
  }
}

export async function loadMigrations(directory = defaultDirectory) {
  try {
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    if (!files.length) throw new MigrationError('SQL-миграции не найдены.');
    const migrations = [];
    for (const file of files) {
      const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
      if (!match || Number(match[1]) !== migrations.length + 1) {
        throw new MigrationError('Нужна последовательность SQL-миграций 0001, 0002, … без пропусков и повторов.');
      }
      // Execute and hash the same LF text on Windows and Unix checkouts.
      const sql = (await readFile(path.join(directory, file), 'utf8')).replace(/\r\n/g, '\n');
      if (!sql.trim()) throw new MigrationError('SQL-миграция не может быть пустой.');
      migrations.push({ version: Number(match[1]), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    }
    return migrations;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('Не удалось прочитать SQL-миграции.');
  }
}

export async function applyMigrations(pool, { directory = defaultDirectory } = {}) {
  const migrations = await loadMigrations(directory);
  let client, locked = false, destroy = false;
  const onClientError = () => { destroy = true; };
  try {
    client = await pool.connect();
    // Checked-out clients can also emit an error between SQL statements.
    client.on('error', onClientError);
    await client.query('SELECT pg_advisory_lock($1, $2)', lockKeys);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    if (rows.some((row, index) => {
      const file = migrations[index];
      return !file || row.version !== file.version || row.name !== file.name || row.checksum !== file.checksum;
    })) {
      throw new MigrationError('История миграций не совпадает с SQL-файлами. Применённые файлы нельзя менять или удалять.');
    }
    const applied = [], skipped = migrations.slice(0, rows.length).map(file => file.name);
    for (const migration of migrations.slice(rows.length)) {
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
        throw new MigrationError(`Не удалось применить ${migration.name}. Текущая миграция не подтверждена; проверьте БД и повторите команду.`);
      }
    }
    return { applied, skipped };
  } catch (error) {
    // A failed lock request has an uncertain outcome at the server. Closing its
    // session also releases a lock acquired just before a timeout/disconnect.
    if (client && !locked) destroy = true;
    if (error instanceof MigrationError) throw error;
    throw new MigrationError();
  } finally {
    if (client) {
      if (locked && !destroy) {
        try { await client.query('SELECT pg_advisory_unlock($1, $2)', lockKeys); }
        catch { destroy = true; }
      }
      client.removeListener('error', onClientError);
      client.release(destroy);
    }
  }
}
