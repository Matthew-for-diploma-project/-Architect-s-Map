import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { Pool } from 'pg';
import worker from '../../dist/server/index.js';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService } from '../../src/backend/sessions.mjs';
import { createAuthenticationGuard } from '../../src/backend/authentication.mjs';
import { createNodeApiHandler } from '../../src/backend/router.mjs';
import { createRequestHandler } from '../../src/backend/http-adapter.mjs';
import { createLoginHandler } from '../../src/backend/login.mjs';
import { createRegistrationHandler } from '../../src/backend/registration.mjs';
import { createMeHandler, createLogoutHandler } from '../../src/backend/account-session.mjs';
import { readAuthRateLimitConfig, createAuthRateLimiter } from '../../src/backend/auth-rate-limit.mjs';
import { hashPassword } from '../../src/backend/passwords.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const config = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test', SESSION_TTL_SECONDS: '300' });
const password = 'P12 fixture password 🔑', credentials = { email: 'alice@example.test', password };
const cookie = response => response.headers.get('set-cookie')?.split(';')[0];
let passwordHash;
before(async () => { passwordHash = await hashPassword(password); });

async function measure(work) {
  let operations = 0;
  const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
  hook.enable();
  try { return { value: await work(), operations }; } finally { hook.disable(); }
}

async function isolated(fn, options = {}) {
  const database = createDatabase(), schema = 'p12_test_' + randomUUID().replaceAll('-', '');
  let pool, server, time = 0, queries = 0, failing = false;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config });
    const rateLimiter = createAuthRateLimiter({ config: readAuthRateLimitConfig({
      AUTH_WINDOW_SECONDS: '10', AUTH_LOGIN_MAX_ATTEMPTS: '2', AUTH_REGISTER_MAX_ATTEMPTS: '2',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,10.0.0.0/8', ...options,
    }), now: () => time });
    const trackedDatabase = { pool: { async query(sql, values) {
      queries++;
      if (failing) throw new Error('P12_SECRET_SQL postgresql://secret');
      return pool.query(sql, values);
    }, connect: pool.connect.bind(pool) } };
    server = http.createServer(createRequestHandler({ worker, nodeApi: createNodeApiHandler({
      database: { pool }, beforeHandle: createAuthenticationGuard({ sessions, config }), handlers: {
        'auth.register': createRegistrationHandler({ database: trackedDatabase, sessions, rateLimiter }),
        'auth.login': createLoginHandler({ database: trackedDatabase, sessions, rateLimiter }),
        'auth.me': createMeHandler(), 'auth.logout': createLogoutHandler({ sessions, config }),
      },
    }) }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const call = (path, init = {}) => fetch(url + path, { ...init, signal: AbortSignal.timeout(10000) });
    const send = (action, body, headers = {}) => call('/api/auth/' + action, {
      method: 'POST', headers: { Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const user = async () => {
      const row = (await pool.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING *', [credentials.email, '<b>P12</b>', passwordHash])).rows[0];
      await pool.query('INSERT INTO layer_settings (user_id) VALUES ($1)', [row.id]);
      return row;
    };
    const counts = async () => {
      const values = [];
      for (const table of ['users', 'layer_settings', 'sessions']) values.push((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return values;
    };
    await fn({ pool, sessions, call, send, user, counts, queryCount: () => queries, failQueries: value => { failing = value; }, advance: ms => { time += ms; } });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

test('P12 login limits normalized known/unknown credentials equally before KDF/SQL and recovers without extending its window', async () => {
  await isolated(async ({ sessions, send, user, counts, queryCount, advance, call }) => {
    const owner = await user(), active = await sessions.issue(owner.id), currentCookie = active.cookie.split(';')[0];
    const errors = [];
    for (const email of [' ALICE@EXAMPLE.TEST ', 'unknown@example.test']) {
      for (let n = 0; n < 2; n++) {
        const result = await measure(() => send('login', { email, password: 'Wrong P12 fixture password' }, { Cookie: currentCookie }));
        assert.equal(result.value.status, 401);
        assert.equal(result.operations, 1);
        errors.push(await result.value.text());
      }
      const before = queryCount();
      const result = await measure(() => send('login', { email: email.trim().toLowerCase(), password }, { Cookie: currentCookie }));
      assert.equal(result.value.status, 429);
      assert.equal(result.value.headers.get('retry-after'), '10');
      assert.equal(result.value.headers.get('set-cookie'), null);
      assert.equal(result.value.headers.get('cache-control'), 'private, no-store');
      assert.equal(result.operations, 0);
      assert.equal(queryCount(), before);
    }
    assert.equal(new Set(errors).size, 1);
    assert.deepEqual(await counts(), [1, 1, 1]);
    assert.equal((await (await call('/api/auth/me', { headers: { Cookie: currentCookie } })).json()).user.id, owner.id);
    advance(9999);
    const denied = await send('login', credentials);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '1');
    advance(1);
    const allowed = await send('login', credentials, { Cookie: currentCookie });
    assert.equal(allowed.status, 200);
    assert.notEqual(cookie(allowed), currentCookie);
    assert.equal(await sessions.resolve(new Headers({ Cookie: currentCookie })), null);
  });
});

test('registration counts successes and duplicates per IP; other IPs and me/logout remain independent', async () => {
  await isolated(async ({ send, call, counts }) => {
    const body = { ...credentials, name: 'P12 регистрация' };
    const registered = await send('register', body);
    assert.equal(registered.status, 201);
    const currentCookie = cookie(registered), owner = (await registered.json()).user;
    assert.equal((await send('register', { ...body, email: ' ALICE@EXAMPLE.TEST ' })).status, 409);
    const before = await counts();
    const denied = await measure(() => send('register', { ...body, email: 'bob@example.test' }, { Cookie: currentCookie }));
    assert.equal(denied.value.status, 429);
    assert.equal(denied.operations, 0);
    assert.equal(denied.value.headers.get('set-cookie'), null);
    assert.deepEqual(await counts(), before);
    assert.equal((await send('register', { ...body, email: 'bob@example.test' }, { 'X-Forwarded-For': '198.51.100.2' })).status, 201);
    const loggedIn = await send('login', credentials, { Cookie: currentCookie });
    assert.equal(loggedIn.status, 200); // Registration quota does not affect login.
    const latest = cookie(loggedIn);
    assert.equal((await (await call('/api/auth/me', { headers: { Cookie: latest } })).json()).user.id, owner.id);
    for (let repeat = 0; repeat < 2; repeat++) {
      const ended = await call('/api/auth/logout', { method: 'POST', headers: { Origin: config.publicOrigin, Cookie: latest } });
      assert.equal(ended.status, 204);
      assert.equal(await ended.text(), '');
    }
    assert.equal((await call('/api/images', { headers: { Cookie: latest } })).status, 401);
  });
});

test('overlapping registrations and logins cannot oversubscribe their allowance', async () => {
  await isolated(async ({ send, counts }) => {
    const attempts = await measure(() => Promise.all(Array.from({ length: 5 }, (_, n) => send('register', {
      email: `parallel${n}@example.test`, password, name: 'P12 parallel',
    }))));
    assert.deepEqual(attempts.value.map(r => r.status).sort(), [201, 201, 429, 429, 429]);
    assert.equal(attempts.operations, 2);
    assert.deepEqual(await counts(), [2, 2, 2]);
    const owner = (await attempts.value.find(r => r.status === 201).json()).user;
    const logins = await measure(() => Promise.all(Array.from({ length: 5 }, () => send('login', { email: owner.email, password: 'Wrong P12 parallel password' }))));
    assert.deepEqual(logins.value.map(r => r.status).sort(), [401, 401, 429, 429, 429]);
    assert.equal(logins.operations, 2);
    assert.deepEqual(await counts(), [2, 2, 2]);
  });
});

test('Origin, malformed/invalid JSON, media and size failures do not consume allowance or run KDF/account SQL', async () => {
  await isolated(async ({ send, counts, queryCount }) => {
    const result = await measure(async () => {
      for (const action of ['register', 'login']) {
        const body = { ...credentials, ...(action === 'register' ? { name: 'P12 fields' } : {}) };
        for (const [value, headers, expected] of [
          [body, { Origin: 'https://evil.test' }, 403], [body, { 'Content-Type': 'text/plain' }, 415],
          ['{bad', {}, 400], [{ ...body, password: 'short' }, {}, 400], ['x'.repeat(16385), {}, 413],
        ]) assert.equal((await send(action, value, headers)).status, expected);
      }
    });
    assert.equal(result.operations, 0);
    assert.equal(queryCount(), 0);
    assert.deepEqual(await counts(), [0, 0, 0]);
    assert.equal((await send('login', credentials)).status, 401);
    assert.equal((await send('login', credentials)).status, 401);
    assert.equal((await send('login', credentials)).status, 429);
    assert.equal((await send('register', { ...credentials, name: 'P12 allowed' })).status, 201);
    assert.equal((await send('register', { ...credentials, email: 'bob@example.test', name: 'P12 allowed' })).status, 201);
    assert.equal((await send('register', { ...credentials, email: 'carol@example.test', name: 'P12 denied' })).status, 429);
  });
});

test('real HTTP ignores spoofed forwarding from untrusted peers and trusts only the nearest untrusted hop of an allowed chain', async () => {
  await isolated(async ({ send }) => {
    for (let n = 0; n < 3; n++) {
      const response = await send('login', credentials, { 'X-Forwarded-For': `203.0.113.${n + 1}`, Forwarded: `for=198.51.100.${n + 1}`, 'X-Real-IP': `192.0.2.${n + 1}` });
      assert.equal(response.status, n < 2 ? 401 : 429);
    }
  }, { TRUSTED_PROXY_CIDRS: '' });
  await isolated(async ({ send }) => {
    for (let n = 0; n < 3; n++) {
      const response = await send('login', credentials, { 'X-Forwarded-For': `203.0.113.${n + 1}, 198.51.100.9, 10.0.0.2` });
      assert.equal(response.status, n < 2 ? 401 : 429);
    }
    assert.equal((await send('login', credentials, { 'X-Forwarded-For': '198.51.100.8,10.0.0.2' })).status, 401);
    assert.equal((await send('login', credentials, { 'X-Forwarded-For': 'garbage,198.51.100.9,10.0.0.2' })).status, 429);
    for (const value of ['garbage', 'unknown', '192.0.2.1,']) {
      const result = await measure(() => send('login', credentials, { 'X-Forwarded-For': value }));
      assert.equal(result.value.status, 400); // Invalid hops cannot acquire a fresh TCP bucket.
      assert.equal(result.operations, 0);
    }
  });
});

test('failed account SQL consumes quota but cannot clear a session or expose SQL; retry works after the window', async () => {
  await isolated(async ({ sessions, user, send, queryCount, failQueries, advance, call }) => {
    const owner = await user(), active = await sessions.issue(owner.id), currentCookie = active.cookie.split(';')[0];
    failQueries(true);
    for (let n = 0; n < 3; n++) {
      const before = queryCount();
      const result = await measure(() => send('login', credentials, { Cookie: currentCookie }));
      assert.equal(result.value.status, n < 2 ? 503 : 429);
      assert.equal(queryCount() - before, n < 2 ? 1 : 0);
      assert.equal(result.operations, 0);
      assert.equal(result.value.headers.get('set-cookie'), null);
      assert.doesNotMatch(await result.value.text(), /P12_SECRET_SQL|postgresql|password|stack|SELECT/);
    }
    assert.equal((await (await call('/api/auth/me', { headers: { Cookie: currentCookie } })).json()).user.id, owner.id);
    failQueries(false);
    advance(10000);
    assert.equal((await send('login', credentials, { Cookie: currentCookie })).status, 200);
  });
});
