import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService, readSessionToken } from '../../src/backend/sessions.mjs';

// Fail before connecting if the caller has not explicitly selected a test DB.
if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const config = readDatabaseConfig();
const publicOrigin = 'http://127.0.0.1:3000';

async function startAdapter(overrides = {}) {
  const child = spawn(process.execPath, ['tools/serve.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: publicOrigin, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const exited = once(child, 'exit');
  for (let i = 0; i < 100; i++) {
    const match = output.match(/ГеоКонтекст: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return { child, exited, url: match[1], output: () => output };
    if (child.exitCode !== null) return { child, exited, output: () => output };
    await delay(50);
  }
  child.kill('SIGKILL');
  await exited;
  throw new Error('Тестовый адаптер не запустился за 5 секунд.');
}

test('PostgreSQL 17: connection, role, parameterized query and pool close', async () => {
  const database = createDatabase();
  try {
    await database.checkConnection();
    const { rows: [row] } = await database.pool.query("SELECT current_database() AS db, current_user AS username, current_setting('server_version_num')::int AS version, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser, $1::text AS value", ['quoted value: \'']);
    assert.equal(row.db, config.database);
    assert.equal(row.username, config.user);
    assert.ok(row.version >= 170000 && row.version < 180000);
    assert.equal(row.superuser, false);
    assert.equal(row.value, "quoted value: '");
    assert.ok(database.pool.totalCount > 0);
  } finally { await database.close(); }
  assert.equal(database.pool.totalCount, 0);
  await database.close();
  await assert.rejects(database.pool.query('SELECT 1'));
});

test('PostgreSQL enforces the configured statement timeout', async () => {
  const database = createDatabase({ env: { ...process.env, DB_STATEMENT_TIMEOUT_MS: '50' } });
  try {
    await assert.rejects(database.pool.query('SELECT pg_sleep(1)'), { code: '57014' });
    await database.checkConnection();
  } finally { await database.close(); }
});

test('an idle connection failure is sanitized and a new connection works', async () => {
  const errors = [];
  const database = createDatabase({ onError: error => errors.push(error) });
  const controller = createDatabase();
  try {
    const { rows: [row] } = await database.pool.query('SELECT pg_backend_pid() AS pid');
    await controller.pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
    for (let i = 0; i < 100 && !errors.length; i++) await delay(20);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'DATABASE_UNAVAILABLE');
    assert.ok(!errors[0].stack.includes(config.password));
    await database.checkConnection();
  } finally { await Promise.all([database.close(), controller.close()]); }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`Node adapter serves the original Worker and closes its pool on ${signal}`, async () => {
    const monitor = createDatabase();
    let adapter;
    try {
      adapter = await startAdapter();
      assert.ok(adapter.url, adapter.output());
      const response = await fetch(adapter.url + '/app.js');
      assert.equal(response.status, 200);
      assert.match(await response.text(), /searchForm/);
      for (const privatePath of ['/.env', '/.env.test', '/src/backend/database-config.mjs', '/compose.yaml']) {
        assert.equal((await fetch(adapter.url + privatePath)).status, 404);
      }
      const count = async () => (await monitor.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [`geokontekst:${adapter.child.pid}`])).rows[0].n;
      assert.equal(await count(), 1);
      adapter.child.kill(signal);
      assert.deepEqual(await adapter.exited, [0, null]);
      assert.equal(await count(), 0);
      assert.ok(!adapter.output().includes(config.password));
    } finally {
      if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
      await monitor.close();
    }
  });
}

test('running Node adapter dispatches new API errors before the original Worker', async () => {
  const adapter = await startAdapter();
  try {
    assert.ok(adapter.url);
    const cases = [
      ['/api/auth/me', {}, 501, 'NOT_IMPLEMENTED'],
      ['/api/images', {}, 401, 'AUTH_REQUIRED'],
      ['/api/auth/unknown', {}, 404, 'NOT_FOUND'],
      ['/api/auth/login', {}, 405, 'METHOD_NOT_ALLOWED'],
      ['/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 403, 'ORIGIN_REJECTED'],
      ['/api/auth/login', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: '{bad' }, 400, 'VALIDATION_ERROR'],
      ['/api/auth/login', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: ' '.repeat(16385) }, 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [path, init, status, code] of cases) {
      const response = await fetch(adapter.url + path, init);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      if (status === 405) assert.equal(response.headers.get('allow'), 'POST');
      assert.equal((await response.json()).error.code, code);
    }
    const legacy = await fetch(adapter.url + '/api/objects', { method: 'POST', body: 'unchanged legacy path' });
    assert.equal(legacy.status, 405);
    assert.deepEqual(await legacy.json(), { error: 'Только GET' });
    assert.ok(!adapter.output().includes(config.password));
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
  } finally {
    if (adapter.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
  }
});

test('HTTP listen failure also releases the database pool', async () => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const monitor = createDatabase();
  try {
    const adapter = await startAdapter({ PORT: String(occupied.address().port) });
    assert.deepEqual(await adapter.exited, [1, null]);
    assert.match(adapter.output(), /Порт \d+ занят/);
    const { rows: [row] } = await monitor.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [`geokontekst:${adapter.child.pid}`]);
    assert.equal(row.n, 0);
  } finally {
    await monitor.close();
    await new Promise(resolve => occupied.close(resolve));
  }
});

test('invalid auth configuration exits safely before HTTP and any database connection', async () => {
  const monitor = createDatabase();
  try {
    for (const overrides of [{ PUBLIC_ORIGIN: '' }, { PUBLIC_ORIGIN: 'https://user:TOP_SECRET@example.test' }, { SESSION_TTL_SECONDS: '0' },
      { NODE_ENV: 'production', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }]) {
      const adapter = await startAdapter(overrides);
      assert.deepEqual(await adapter.exited, [1, null]);
      assert.equal(adapter.url, undefined);
      assert.match(adapter.output(), /PUBLIC_ORIGIN|SESSION_TTL_SECONDS/);
      assert.doesNotMatch(adapter.output(), /TOP_SECRET|postgresql:\/\//);
      const { rows: [row] } = await monitor.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1', [`geokontekst:${adapter.child.pid}`]);
      assert.equal(row.n, 0);
    }
  } finally { await monitor.close(); }
});

test('running Node enforces persisted session, expiry and revocation across restart without leaking cookies', async () => {
  const database = createDatabase();
  const userId = randomUUID();
  const sessions = createSessionService({ database, config: readAuthConfig({ PUBLIC_ORIGIN: publicOrigin, SESSION_TTL_SECONDS: '300' }) });
  let adapter;
  try {
    // Only this named fixture is written to the explicitly guarded TEST database.
    await database.pool.query('INSERT INTO public.users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)',
      [userId, userId + '@example.test', 'P08 process fixture', 'scrypt$P08_TEST_ONLY']);
    const first = await sessions.issue(userId), other = await sessions.issue(userId);
    const firstCookie = first.cookie.split(';')[0], otherCookie = other.cookie.split(';')[0];
    const token = readSessionToken(firstCookie);
    adapter = await startAdapter();
    const call = (path, init) => fetch(adapter.url + path, init);
    assert.equal((await call('/api/images')).status, 401);
    assert.equal((await call('/api/images?token=' + token)).status, 401);
    assert.equal((await call('/api/images', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
    assert.equal((await call('/api/images', { headers: { Cookie: firstCookie + '; ' + firstCookie } })).status, 401);
    assert.equal((await call('/api/images', { headers: { Cookie: 'am_session=' + randomBytes(32).toString('base64url') } })).status, 401);
    const authenticated = await call('/api/images', { headers: { Cookie: firstCookie } });
    assert.equal(authenticated.status, 501); // Authorization passed; CRUD is a later iteration.
    assert.equal(authenticated.headers.get('set-cookie'), null); // No automatic renewal.
    assert.ok(!(await authenticated.text()).includes(token));
    assert.equal((await call('/api/images', { method: 'POST', headers: { Origin: 'https://evil.test', Cookie: firstCookie }, body: 'unread' })).status, 403);
    assert.equal((await call('/api/images', { method: 'POST', headers: { Origin: publicOrigin, Cookie: firstCookie }, body: 'unread' })).status, 501);
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
    const firstOutput = adapter.output();
    adapter = await startAdapter();
    assert.equal((await call('/api/layer-settings', { headers: { Cookie: firstCookie } })).status, 501);
    await sessions.revoke(first.id);
    assert.equal((await call('/api/images', { headers: { Cookie: firstCookie } })).status, 401);
    assert.equal((await call('/api/images', { headers: { Cookie: otherCookie } })).status, 501);
    await database.pool.query("UPDATE public.sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours', expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1", [other.id]);
    assert.equal((await call('/api/images', { headers: { Cookie: otherCookie } })).status, 401);
    assert.ok(!(firstOutput + adapter.output()).includes(token));
    assert.ok(!(firstOutput + adapter.output()).includes(readSessionToken(otherCookie)));
    assert.ok(!adapter.output().includes(config.password));
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
  } finally {
    if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
    await database.pool.query('DELETE FROM public.users WHERE id=$1', [userId]);
    await database.close();
  }
});

test('wrong credentials fail safely before the HTTP server is opened', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.password = 'wrong-password-for-P03-test';
  const adapter = await startAdapter({ TEST_DATABASE_URL: url.href });
  assert.deepEqual(await adapter.exited, [1, null]);
  assert.match(adapter.output(), /PostgreSQL недоступна/);
  assert.doesNotMatch(adapter.output(), /wrong-password-for-P03-test|postgresql:\/\//);
  assert.equal(adapter.url, undefined);
});
