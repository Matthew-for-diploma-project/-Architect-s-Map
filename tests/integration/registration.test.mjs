import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import worker from '../../dist/server/index.js';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService, readSessionToken } from '../../src/backend/sessions.mjs';
import { createAuthenticationGuard } from '../../src/backend/authentication.mjs';
import { createNodeApiHandler } from '../../src/backend/router.mjs';
import { createRequestHandler } from '../../src/backend/http-adapter.mjs';
import { createRegistrationHandler } from '../../src/backend/registration.mjs';
import { verifyPassword } from '../../src/backend/passwords.mjs';
import { ApiError } from '../../src/backend/http-errors.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const config = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test', SESSION_TTL_SECONDS: '300' });
const password = 'P09 integration fixture password 🔑';
const account = { email: ' ALICE@EXAMPLE.TEST ', password, name: ' <b>Алиса</b> ' };
const cookiePart = response => response.headers.get('set-cookie')?.split(';')[0];

async function isolated(fn, { queryHook, sessionFactory } = {}) {
  const database = createDatabase();
  const schema = 'p09_test_' + randomUUID().replaceAll('-', '');
  let pool, server;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config });
    const registeringPool = queryHook ? { async connect() {
      const client = await pool.connect();
      return {
        query: (sql, values) => queryHook(client, sql, values, database.pool),
        on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
      };
    } } : pool;
    const handler = createRegistrationHandler({ database: { pool: registeringPool }, sessions: sessionFactory ? sessionFactory(sessions) : sessions });
    server = http.createServer(createRequestHandler({ worker, nodeApi: createNodeApiHandler({
      database: { pool }, beforeHandle: createAuthenticationGuard({ sessions, config }), handlers: { 'auth.register': handler },
    }) }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const send = (body, headers = {}) => fetch(url + '/api/auth/register', {
      method: 'POST', headers: { Origin: config.publicOrigin, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const counts = async () => {
      const result = [];
      for (const table of ['users', 'layer_settings', 'sessions']) result.push((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return result;
    };
    await fn({ pool, sessions, send, counts, url });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

test('P09 HTTP registration commits normalized user, default layer and hashed session with a safe 201/cookie', async () => {
  await isolated(async ({ pool, sessions, send, counts, url }) => {
    const response = await send(account);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['user']);
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name']);
    assert.equal(body.user.email, 'alice@example.test');
    assert.equal(body.user.name, '<b>Алиса</b>');
    const row = (await pool.query('SELECT * FROM users WHERE id=$1', [body.user.id])).rows[0];
    assert.ok(!JSON.stringify(body).includes(password));
    assert.ok(!JSON.stringify(body).includes(row.password_hash));
    assert.equal(await verifyPassword(password, row.password_hash), true);
    assert.equal(await verifyPassword('Wrong P09 fixture password', row.password_hash), false);
    const settings = (await pool.query('SELECT * FROM layer_settings WHERE user_id=$1', [row.id])).rows[0];
    assert.equal(settings.opacity, 1);
    assert.equal(settings.revision, 1);
    const cookie = cookiePart(response), token = readSessionToken(cookie);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/; Secure$/);
    assert.deepEqual((await sessions.resolve(new Headers({ Cookie: cookie }))).user, body.user);
    const session = (await pool.query('SELECT * FROM sessions WHERE user_id=$1', [row.id])).rows[0];
    assert.deepEqual(session.token_hash, createHash('sha256').update(token, 'ascii').digest());
    assert.ok(!JSON.stringify(body).includes(token));
    assert.equal((await fetch(url + '/api/images', { headers: { Cookie: cookie } })).status, 501);
    assert.deepEqual(await counts(), [1, 1, 1]);
  });
});

test('invalid input, media/size and Origin failures create no account, setting or session', async () => {
  await isolated(async ({ send, counts }) => {
    for (const [body, headers, status, code] of [
      [{}, {}, 400, 'VALIDATION_ERROR'], [{ ...account, password: 'SHORT' }, {}, 400, 'VALIDATION_ERROR'],
      [{ ...account, userId: 'forged' }, {}, 400, 'VALIDATION_ERROR'],
      ['{bad JSON TOP_SECRET', {}, 400, 'VALIDATION_ERROR'],
      [account, { 'Content-Type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [' '.repeat(16385), {}, 413, 'PAYLOAD_TOO_LARGE'],
      [account, { Origin: 'null' }, 403, 'ORIGIN_REJECTED'], [account, { Origin: 'https://evil.test' }, 403, 'ORIGIN_REJECTED'],
    ]) {
      const response = await send(body, headers);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('set-cookie'), null);
      const value = await response.json();
      assert.equal(value.error.code, code);
      assert.ok(!JSON.stringify(value).includes(password));
      assert.doesNotMatch(JSON.stringify(value), /TOP_SECRET|forged/);
    }
    assert.deepEqual(await counts(), [0, 0, 0]);
  });
});

test('case-insensitive duplicate registration returns 409 without another setting/session or cookie', async () => {
  await isolated(async ({ send, counts }) => {
    assert.equal((await send(account)).status, 201);
    const duplicate = await send({ ...account, email: ' alice@example.test ', name: 'Другое имя' });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'EMAIL_EXISTS');
    assert.equal(duplicate.headers.get('set-cookie'), null);
    assert.deepEqual(await counts(), [1, 1, 1]);
  });
});

test('two overlapping registration transactions for case variants produce one winner and one 409', async () => {
  let began = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await isolated(async ({ send, counts }) => {
    const responses = await Promise.all([send(account), send({ ...account, email: 'alice@example.test', name: 'Вторая' })]);
    assert.equal(began, 2);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.equal(responses.filter(response => response.headers.get('set-cookie')).length, 1);
    assert.deepEqual(await counts(), [1, 1, 1]);
  }, { queryHook: async (client, sql, values) => {
    const result = await client.query(sql, values);
    if (sql === 'BEGIN') { began++; if (began === 2) release(); await gate; }
    return result;
  } });
});

test('real settings/session INSERT failures roll back all earlier registration writes', async () => {
  for (const table of ['layer_settings', 'sessions']) {
    await isolated(async ({ pool, send, counts }) => {
      await pool.query("CREATE FUNCTION p09_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P09_SQL_SECRET'; END; $$");
      await pool.query(`CREATE TRIGGER p09_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION p09_fail()`);
      const response = await send(account);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.text();
      assert.equal(JSON.parse(body).error.code, 'DATABASE_UNAVAILABLE');
      assert.doesNotMatch(body, /P09_SQL_SECRET|INSERT|password_hash|stack/);
      assert.deepEqual(await counts(), [0, 0, 0]);
    });
  }
});

test('registration rollback restores the previous browser session; success switches accounts and preserves another device', async () => {
  let failAfterIssue = false;
  await isolated(async ({ send, sessions, counts }) => {
    const a = await send(account), aBody = await a.json(), oldCookie = cookiePart(a);
    const other = await sessions.issue(aBody.user.id);
    const b = { ...account, email: 'b@example.test', name: 'B' };
    failAfterIssue = true;
    const failed = await send(b, { Cookie: oldCookie });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('set-cookie'), null);
    assert.deepEqual(await counts(), [1, 1, 2]);
    assert.equal((await sessions.resolve(new Headers({ Cookie: oldCookie }))).user.id, aBody.user.id);
    failAfterIssue = false;
    const created = await send(b, { Cookie: oldCookie });
    assert.equal(created.status, 201);
    const bBody = await created.json(), newCookie = cookiePart(created);
    assert.equal(await sessions.resolve(new Headers({ Cookie: oldCookie })), null);
    assert.equal((await sessions.resolve(new Headers({ Cookie: newCookie }))).user.id, bBody.user.id);
    assert.equal((await sessions.resolve(new Headers({ Cookie: other.cookie.split(';')[0] }))).user.id, aBody.user.id);
    assert.deepEqual(await counts(), [2, 2, 2]);
  }, { sessionFactory: sessions => ({ ...sessions, async issue(...args) {
    const issued = await sessions.issue(...args);
    if (failAfterIssue) throw new ApiError('INTERNAL_ERROR');
    return issued;
  } }) });
});

test('losing the checked-out PostgreSQL connection rolls back registration without an unhandled error or cookie', async () => {
  let observedSleep = false;
  await isolated(async ({ pool, send, counts }) => {
    await pool.query('CREATE FUNCTION p09_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END; $$');
    await pool.query('CREATE TRIGGER p09_pause BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION p09_pause()');
    const response = await send(account);
    assert.equal(observedSleep, true);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
    assert.deepEqual(await counts(), [0, 0, 0]);
  }, { queryHook: async (client, sql, values, monitor) => {
    if (!sql.includes('WITH issued AS')) return client.query(sql, values);
    const outcome = client.query(sql, values).then(value => ({ value }), error => ({ error }));
    try {
      for (let i = 0; i < 100; i++) {
        const row = (await monitor.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [client.processID])).rows[0];
        if (row?.wait_event === 'PgSleep') { observedSleep = true; break; }
        await delay(10);
      }
    } finally { await monitor.query('SELECT pg_terminate_backend($1)', [client.processID]); }
    const result = await outcome;
    if (result.error) throw result.error;
    return result.value;
  } });
});
