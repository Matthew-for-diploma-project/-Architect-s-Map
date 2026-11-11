import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { validateRegistration, validateLogin, toPublicUser } from '../../src/backend/account-validation.mjs';
import { hashPassword, verifyPassword } from '../../src/backend/passwords.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const config = readDatabaseConfig(); // Guard the database before creating a schema.

test('P07 normalized accounts and password hashes round trip through the existing PostgreSQL schema', async () => {
  const database = createDatabase();
  const schema = 'p07_test_' + randomUUID().replaceAll('-', '');
  let pool;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const password = 'P07 database fixture 🔑'; // Public fixture, never a credential.
    const encoded = await hashPassword(password);
    const inputs = [' ALICE@EXAMPLE.TEST ', ' Пользователь@ПРИМЕР.ТЕСТ ', 'İ@Example.Test', 'ΟΣ@Example.Test'];
    for (const input of inputs) {
      const validated = validateRegistration({ email: input, password, name: ' <img src=x onerror=alert(1)> ' });
      const { rows: [row] } = await pool.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *',
        [validated.email, validated.name, encoded],
      );
      assert.equal(row.email, validated.email);
      assert.equal(row.name, validated.name);
      assert.equal(row.password_hash, encoded);
      const login = validateLogin({ email: input, password });
      const { rows: [found] } = await pool.query('SELECT * FROM users WHERE email=$1', [login.email]);
      assert.equal(found.id, row.id);
      const profile = toPublicUser(found);
      assert.deepEqual(profile, { id: row.id, email: validated.email, name: validated.name });
      assert.ok(!JSON.stringify(profile).includes(encoded));
      assert.ok(!JSON.stringify(profile).includes(password));
      await assert.rejects(pool.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)',
        [login.email, 'Повторная почта', encoded],
      ), { code: '23505', constraint: 'users_email_key' });
    }
    const { rows: [known] } = await pool.query('SELECT password_hash FROM users WHERE email=$1', ['alice@example.test']);
    assert.equal(await verifyPassword(password, known.password_hash), true);
    assert.equal(await verifyPassword('Wrong database fixture password', known.password_hash), false);
    const { rows: [unknown] } = await pool.query('SELECT password_hash FROM users WHERE email=$1', ['missing@example.test']);
    assert.equal(await verifyPassword(password, unknown?.password_hash), false);
    // No sessions/settings/HTTP registration are created by P07's primitives.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM layer_settings')).rows[0].n, 0);
  } finally {
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
});
