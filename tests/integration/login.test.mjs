import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHook } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { createLoginHandler } from '../../src/backend/login.mjs';
import { hashPassword } from '../../src/backend/passwords.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const config = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test', SESSION_TTL_SECONDS: '300' });
const password = '  P10 database e\u0301 password 🔑  ';
const credentials = { email: ' ALICE@EXAMPLE.TEST ', password };
const cookiePart = response => response.headers.get('set-cookie')?.split(';')[0];
let passwordHash;
before(async () => { passwordHash = await hashPassword(password); });

async function isolated(fn, { afterVerify, queryHook } = {}) {
  const database = createDatabase(), schema = 'p10_test_' + randomUUID().replaceAll('-', '');
  let pool, server;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config });
    const loginPool = { query: pool.query.bind(pool), async connect() {
      const client = await pool.connect();
      try { await afterVerify?.({ pool, monitor: database.pool, schema }); }
      catch (error) { client.release(true); throw error; }
      return {
        query: (sql, values) => queryHook ? queryHook(client, sql, values, database.pool, schema) : client.query(sql, values),
        on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
      };
    } };
    server = http.createServer(createRequestHandler({ worker, nodeApi: createNodeApiHandler({
      database: { pool }, beforeHandle: createAuthenticationGuard({ sessions, config }),
      handlers: { 'auth.login': createLoginHandler({ database: { pool: loginPool }, sessions }) },
    }) }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const send = (body, headers = {}) => fetch(url + '/api/auth/login', {
      method: 'POST', headers: { Origin: config.publicOrigin, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const user = async (email = 'alice@example.test', name = '<b>Алиса</b>') => {
      const row = (await pool.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING *', [email, name, passwordHash])).rows[0];
      await pool.query('INSERT INTO layer_settings (user_id) VALUES ($1)', [row.id]);
      return row;
    };
    const counts = async () => {
      const values = [];
      for (const table of ['users', 'layer_settings', 'sessions']) values.push((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return values;
    };
    await fn({ pool, sessions, send, user, counts, url });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

test('P10 HTTP login normalizes email, preserves user/layer data and returns a fresh working cookie with safe 200', async () => {
  await isolated(async ({ pool, sessions, send, user, url }) => {
    const owner = await user();
    await pool.query('UPDATE layer_settings SET opacity=.35,revision=2 WHERE user_id=$1', [owner.id]);
    const settings = (await pool.query('SELECT * FROM layer_settings')).rows[0];
    const old = await sessions.issue(owner.id);
    const response = await send(credentials, { Cookie: old.cookie.split(';')[0] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.json();
    assert.deepEqual(body, { user: { id: owner.id, email: owner.email, name: owner.name } });
    const cookie = cookiePart(response), token = readSessionToken(cookie);
    assert.notEqual(token, readSessionToken(old.cookie.split(';')[0]));
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/; Secure$/);
    for (const secret of [password, passwordHash, token]) assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal(await sessions.resolve(new Headers({ Cookie: old.cookie.split(';')[0] })), null);
    assert.deepEqual((await sessions.resolve(new Headers({ Cookie: cookie }))).user, body.user);
    const row = (await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [owner.id])).rows[0];
    assert.deepEqual(row.token_hash, createHash('sha256').update(token, 'ascii').digest());
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows[0], owner);
    assert.deepEqual((await pool.query('SELECT * FROM layer_settings')).rows[0], settings);
    assert.equal((await fetch(url + '/api/images', { headers: { Cookie: cookie } })).status, 501);
  });
});

test('wrong/unknown/corrupt-hash HTTP logins have the same 401 and one scrypt without changing an existing session', async () => {
  await isolated(async ({ pool, sessions, send, user, counts }) => {
    const owner = await user(), corrupt = await user('corrupt@example.test');
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', ['P10_CORRUPT_HASH', corrupt.id]);
    const current = await sessions.issue(owner.id), headers = { Cookie: current.cookie.split(';')[0] };
    const bodies = [];
    for (const body of [{ ...credentials, password: 'Wrong P10 fixture password' }, { ...credentials, email: 'missing@example.test' }, { ...credentials, email: corrupt.email }]) {
      let operations = 0;
      const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
      hook.enable();
      let response;
      try { response = await send(body, headers); } finally { hook.disable(); }
      assert.equal(operations, 1);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      bodies.push(await response.text());
    }
    assert.equal(new Set(bodies).size, 1);
    assert.equal(JSON.parse(bodies[0]).error.code, 'INVALID_CREDENTIALS');
    assert.doesNotMatch(bodies[0], /P10_CORRUPT_HASH|password_hash|SELECT|missing@example/);
    assert.deepEqual(await counts(), [2, 2, 1]);
    assert.equal((await sessions.resolve(new Headers(headers))).user.id, owner.id);
  });
});

test('repeated login rotates the current cookie and account switching preserves another device', async () => {
  await isolated(async ({ sessions, send, user, counts }) => {
    const a = await user(), b = await user('b@example.test', 'B');
    const first = await sessions.issue(a.id), otherDevice = await sessions.issue(a.id);
    let cookie = first.cookie.split(';')[0];
    for (let i = 0; i < 2; i++) {
      const response = await send(credentials, { Cookie: cookie });
      assert.equal(response.status, 200);
      const next = cookiePart(response);
      assert.notEqual(next, cookie);
      assert.equal(await sessions.resolve(new Headers({ Cookie: cookie })), null);
      cookie = next;
    }
    const switched = await send({ ...credentials, email: b.email }, { Cookie: cookie });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).user.id, b.id);
    assert.equal(await sessions.resolve(new Headers({ Cookie: cookie })), null);
    assert.equal((await sessions.resolve(new Headers({ Cookie: cookiePart(switched) }))).user.id, b.id);
    assert.equal((await sessions.resolve(new Headers({ Cookie: otherDevice.cookie.split(';')[0] }))).user.id, a.id);
    assert.deepEqual(await counts(), [2, 2, 2]);
  });
});

test('invalid login fields/JSON/media/size/Origin do no password work and create no records', async () => {
  await isolated(async ({ send, counts }) => {
    let operations = 0;
    const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
    hook.enable();
    try {
      for (const [body, headers, status] of [[{}, {}, 400], [{ ...credentials, password: 'SHORT' }, {}, 400],
        [{ ...credentials, userId: 'forged' }, {}, 400], ['{bad JSON', {}, 400], [credentials, { 'Content-Type': 'text/plain' }, 415],
        [' '.repeat(16385), {}, 413], [credentials, { Origin: 'null' }, 403], [credentials, { Origin: 'https://evil.test' }, 403]]) {
        const response = await send(body, headers);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.ok(!(await response.text()).includes(password));
      }
    } finally { hook.disable(); }
    assert.equal(operations, 0);
    assert.deepEqual(await counts(), [0, 0, 0]);
  });
});

test('an account changed or deleted during verification cannot receive a session from a stale password snapshot', async () => {
  for (const mutation of ['change', 'delete']) {
    await isolated(async ({ send, user, counts }) => {
      await user();
      const response = await send(credentials);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'INVALID_CREDENTIALS');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await counts(), mutation === 'delete' ? [0, 0, 0] : [1, 1, 0]);
    }, { afterVerify: async ({ pool }) => {
      if (mutation === 'delete') await pool.query('DELETE FROM users');
      else await pool.query("UPDATE users SET password_hash='P10_CHANGED_HASH'");
    } });
  }
});

test('failed session insertion rolls back login and preserves the previous browser and other device', async () => {
  await isolated(async ({ pool, sessions, send, user, counts }) => {
    const a = await user(), b = await user('b@example.test');
    const current = await sessions.issue(a.id), other = await sessions.issue(a.id);
    await pool.query("CREATE FUNCTION p10_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P10_SQL_SECRET'; END; $$");
    await pool.query('CREATE TRIGGER p10_fail BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION p10_fail()');
    const response = await send({ ...credentials, email: b.email }, { Cookie: current.cookie.split(';')[0] });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'DATABASE_UNAVAILABLE');
    assert.doesNotMatch(body, /P10_SQL_SECRET|INSERT|password_hash|stack/);
    assert.equal((await sessions.resolve(new Headers({ Cookie: current.cookie.split(';')[0] }))).user.id, a.id);
    assert.equal((await sessions.resolve(new Headers({ Cookie: other.cookie.split(';')[0] }))).user.id, a.id);
    assert.deepEqual(await counts(), [2, 2, 2]);
  });
});

test('the verified user row stays locked against profile updates until session commit', async () => {
  let owner, updater, updating, blocked = false;
  await isolated(async ({ pool, send, user }) => {
    owner = await user();
    try {
      const response = await send(credentials);
      assert.equal(response.status, 200);
      assert.equal(blocked, true);
      assert.equal((await response.json()).user.name, owner.name);
      const outcome = await updating;
      assert.equal(outcome.error, undefined);
      assert.equal((await pool.query('SELECT name FROM users WHERE id=$1', [owner.id])).rows[0].name, 'Новое имя');
    } finally {
      await updating;
      updater?.release();
    }
  }, { queryHook: async (client, sql, values, monitor, schema) => {
    if (!sql.includes('WITH issued AS')) return client.query(sql, values);
    updater = await monitor.connect();
    updating = updater.query(`UPDATE "${schema}".users SET name=$1 WHERE id=$2`, ['Новое имя', owner.id])
      .then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 100; i++) {
      const row = (await monitor.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [updater.processID])).rows[0];
      if (row?.wait_event_type === 'Lock') { blocked = true; break; }
      await delay(10);
    }
    return client.query(sql, values);
  } });
});
