import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations, loadMigrations, MigrationError } from '../../src/backend/migrations.mjs';

// Validate the target before even creating a test schema. Never use DATABASE_URL.
if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const config = readDatabaseConfig();
const hashFixture = 'scrypt$P04_TEST_ONLY$salt$params$hash'; // Not a login credential.

async function isolatedSchema(fn) {
  const admin = createDatabase();
  const schema = 'p04_test_' + randomUUID().replaceAll('-', '');
  const options = `-c search_path=${schema},pg_catalog`;
  let pool;
  try {
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options });
    pool.on('error', () => {}); // Query failures are asserted; do not log raw errors.
    return await fn(pool, schema, options);
  } finally {
    await pool?.end();
    await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.close();
  }
}

async function temporaryPlan(files, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'geokontekst-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql);
    return await fn(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function user(pool, email = 'p04@example.test') {
  return (await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *', [email, 'Тестовый пользователь', hashFixture])).rows[0];
}

test('clean schema migrates once; a repeated run preserves users and history', async () => {
  await isolatedSchema(async (pool, schema) => {
    const count = (await loadMigrations()).length;
    assert.equal((await applyMigrations(pool)).applied.length, count);
    const saved = await user(pool);
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.ok(saved.created_at instanceof Date);
    const history = (await pool.query('SELECT * FROM schema_migrations')).rows;
    const second = await applyMigrations(pool);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, count);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations')).rows, history);
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows, [saved]);
    const indexes = (await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [schema])).rows.map(row => row.indexname);
    for (const name of ['users_email_key', 'sessions_token_hash_key', 'sessions_user_id_idx', 'sessions_expires_at_idx']) assert.ok(indexes.includes(name));
  });
});

test('database canonicalizes email and rejects case collisions on insert and update', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const first = await user(pool, '  Alice@Example.TEST  ');
    assert.equal(first.email, 'alice@example.test');
    await assert.rejects(user(pool, 'ALICE@example.test'), { code: '23505', constraint: 'users_email_key' });
    const second = await user(pool, 'other@example.test');
    await assert.rejects(pool.query('UPDATE users SET email = $1 WHERE id = $2', [' Alice@EXAMPLE.TEST ', second.id]), { code: '23505' });
    assert.equal((await pool.query('SELECT email FROM users WHERE id = $1', [second.id])).rows[0].email, 'other@example.test');
    const unicode = await user(pool, 'ПОЛЬЗОВАТЕЛЬ@ПРИМЕР.ТЕСТ');
    assert.equal(unicode.email, 'пользователь@пример.тест');
    await assert.rejects(user(pool, unicode.email), { code: '23505' });
  });
});

test('concurrent case variants cannot create two accounts', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const results = await Promise.allSettled([user(pool, 'Race@Example.test'), user(pool, 'RACE@example.TEST')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, '23505');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });
});

test('required fields and session ownership are enforced by PostgreSQL', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    for (const values of [[null, 'Имя', hashFixture], ['a@example.test', null, hashFixture], ['a@example.test', 'Имя', null]]) {
      await assert.rejects(pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)', values), { code: '23502' });
    }
    for (const values of [['', 'Имя', hashFixture], ['a@example.test', ' ', hashFixture], ['a@example.test', 'x'.repeat(81), hashFixture], ['a@example.test', 'Имя', '']]) {
      await assert.rejects(pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)', values), { code: '23514' });
    }
    await assert.rejects(pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,now()+interval '1 day')", [randomBytes(32), randomUUID()]), { code: '23503' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
  });
});

test('sessions store unique SHA-256 digests, valid lifetimes and cascade on user deletion', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool), digest = randomBytes(32);
    const insert = (hash, expiry) => pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3) RETURNING *', [hash, account.id, expiry]);
    const future = new Date(Date.now() + 86400000);
    const saved = (await insert(digest, future)).rows[0];
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.token_hash.equals(digest), true);
    assert.equal(saved.user_id, account.id);
    assert.ok(saved.created_at < saved.expires_at);
    await assert.rejects(insert(digest, future), { code: '23505' });
    await assert.rejects(insert(randomBytes(31), future), { code: '23514' });
    await assert.rejects(insert(randomBytes(32), new Date(0)), { code: '23514' });
    await pool.query('DELETE FROM users WHERE id = $1', [account.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
  });
});

test('failed next migration rolls back its DDL and history and can be repaired', async () => {
  await isolatedSchema(async (pool, schema, options) => {
    const [first] = await loadMigrations();
    await temporaryPlan({ [first.name]: first.sql }, async directory => {
      await applyMigrations(pool, { directory });
      const saved = await user(pool);
      await writeFile(path.join(directory, '0002_fixture.sql'), "CREATE TABLE p04_fixture (id integer); SELECT 'MIGRATION_TOP_SECRET'::integer;");
      await assert.rejects(applyMigrations(pool, { directory }), error => {
        assert.ok(error instanceof MigrationError);
        assert.doesNotMatch(error.stack, /MIGRATION_TOP_SECRET/);
        return true;
      });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
      assert.equal((await pool.query("SELECT to_regclass('p04_fixture') AS name")).rows[0].name, null);
      assert.equal((await pool.query('SELECT id FROM users')).rows[0].id, saved.id);
      await writeFile(path.join(directory, '0002_fixture.sql'), 'CREATE TABLE p04_fixture (id integer);');
      // A different session must obtain the lock after failure, not a reentrant lock.
      const fresh = new Pool({ ...config, options, statement_timeout: 1000 });
      try {
        const result = await applyMigrations(fresh, { directory });
        assert.equal(result.applied.length, 1);
        assert.equal(result.skipped.length, 1);
        assert.equal((await applyMigrations(fresh, { directory })).skipped.length, 2);
      } finally { await fresh.end(); }
    });
  });
});

test('edited or missing applied SQL files stop the runner without changing existing data', async () => {
  await isolatedSchema(async pool => {
    const [first] = await loadMigrations();
    await temporaryPlan({ [first.name]: first.sql }, async directory => {
      await applyMigrations(pool, { directory });
      const saved = await user(pool);
      await writeFile(path.join(directory, first.name), first.sql + '\n-- changed');
      await assert.rejects(applyMigrations(pool, { directory }), /История миграций/);
      await rm(path.join(directory, first.name));
      await writeFile(path.join(directory, '0001_different.sql'), 'SELECT 1;');
      await assert.rejects(applyMigrations(pool, { directory }), /История миграций/);
      assert.equal((await pool.query('SELECT id FROM users')).rows[0].id, saved.id);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
    });
  });
});

test('parallel migration runners serialize and apply a version only once', async () => {
  await isolatedSchema(async pool => {
    const count = (await loadMigrations()).length;
    const results = await Promise.all([applyMigrations(pool), applyMigrations(pool)]);
    assert.deepEqual(results.map(result => result.applied.length).sort(), [0, count]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, count);
    assert.equal(pool.waitingCount, 0);
  });
});

test('a timed-out waiting runner discards its session and can retry', async () => {
  await isolatedSchema(async (pool, schema, options) => {
    const gateKey = randomBytes(4).readUInt32BE() & 0x3fffffff;
    await temporaryPlan({ '0001_wait.sql': `CREATE TABLE p04_wait (id integer); SELECT pg_advisory_xact_lock(${gateKey}, 42);` }, async directory => {
      const controller = new Pool({ ...config, options });
      const blocked = new Pool({ ...config, options, statement_timeout: 50 });
      const gate = await controller.connect();
      let first, held = false;
      try {
        await gate.query('SELECT pg_advisory_lock($1, 42)', [gateKey]);
        held = true;
        first = applyMigrations(pool, { directory });
        let ready = false;
        for (let i = 0; i < 100; i++) {
          if ((await gate.query("SELECT to_regclass('schema_migrations') AS name")).rows[0].name) { ready = true; break; }
          await delay(20);
        }
        assert.equal(ready, true);
        await assert.rejects(applyMigrations(blocked, { directory }), MigrationError);
        assert.equal(blocked.totalCount, 0);
        await gate.query('SELECT pg_advisory_unlock($1, 42)', [gateKey]);
        held = false;
        assert.equal((await first).applied.length, 1);
        assert.equal((await applyMigrations(blocked, { directory })).skipped.length, 1);
      } finally {
        if (held) await gate.query('SELECT pg_advisory_unlock($1, 42)', [gateKey]);
        gate.release();
        if (first) await first.catch(() => {});
        await Promise.all([controller.end(), blocked.end()]);
      }
    });
  });
});

test('lost migration connection rolls back the transaction and permits a later run', async () => {
  await isolatedSchema(async (pool, schema, options) => {
    await temporaryPlan({ '0001_connection_loss.sql': 'CREATE TABLE p04_connection_loss (id integer); SELECT pg_sleep(5);' }, async directory => {
      const controller = new Pool({ ...config, options });
      let pid;
      const runnerPool = { async connect() {
        const client = await pool.connect();
        pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return client;
      } };
      try {
        const failure = assert.rejects(applyMigrations(runnerPool, { directory }), MigrationError);
        let active = false;
        for (let i = 0; i < 100; i++) {
          if (pid) {
            const row = (await controller.query('SELECT state, query FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0];
            if (row?.state === 'active' && row.query.includes('pg_sleep(5)')) { active = true; break; }
          }
          await delay(20);
        }
        assert.equal(active, true);
        await controller.query('SELECT pg_terminate_backend($1)', [pid]);
        await failure;
        assert.equal((await controller.query("SELECT to_regclass('p04_connection_loss') AS name")).rows[0].name, null);
        assert.equal((await controller.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0);
        await writeFile(path.join(directory, '0001_connection_loss.sql'), 'CREATE TABLE p04_connection_loss (id integer);');
        assert.equal((await applyMigrations(controller, { directory })).applied.length, 1);
      } finally { await controller.end(); }
    });
  });
});
