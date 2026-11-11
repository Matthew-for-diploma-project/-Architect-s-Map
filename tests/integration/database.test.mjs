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
import { hashPassword } from '../../src/backend/passwords.mjs';

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
      { AUTH_WINDOW_SECONDS: '0' }, { AUTH_LOGIN_MAX_ATTEMPTS: '-1' }, { AUTH_REGISTER_MAX_ATTEMPTS: '1.5' },
      { TRUSTED_PROXY_CIDRS: 'TOP_SECRET_PROXY/32' },
      { NODE_ENV: 'production', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }]) {
      const adapter = await startAdapter(overrides);
      assert.deepEqual(await adapter.exited, [1, null]);
      assert.equal(adapter.url, undefined);
      assert.match(adapter.output(), /PUBLIC_ORIGIN|SESSION_TTL_SECONDS|AUTH_WINDOW_SECONDS|AUTH_LOGIN_MAX_ATTEMPTS|AUTH_REGISTER_MAX_ATTEMPTS|TRUSTED_PROXY_CIDRS/);
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

test('running Node registers an account, sets a working cookie and safely rejects duplicates', async () => {
  const database = createDatabase();
  const email = randomUUID() + '@example.test';
  const password = 'P09 process fixture password';
  let adapter;
  try {
    adapter = await startAdapter();
    assert.ok(adapter.url, adapter.output());
    const send = body => fetch(adapter.url + '/api/auth/register', {
      method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await send({ email: ' ' + email.toUpperCase() + ' ', password, name: ' P09 пользователь ' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json();
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name']);
    assert.equal(body.user.email, email);
    assert.equal(body.user.name, 'P09 пользователь');
    const cookie = response.headers.get('set-cookie').split(';')[0], token = readSessionToken(cookie);
    const row = (await database.pool.query('SELECT u.password_hash,l.opacity,l.revision FROM public.users u JOIN public.layer_settings l ON l.user_id=u.id WHERE u.id=$1', [body.user.id])).rows[0];
    assert.match(row.password_hash, /^scrypt\$v=1\$/);
    assert.equal(row.opacity, 1);
    assert.equal(row.revision, 1);
    assert.ok(!JSON.stringify(body).includes(token));
    assert.ok(!JSON.stringify(body).includes(password));
    assert.ok(!JSON.stringify(body).includes(row.password_hash));
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: cookie } })).status, 501);
    const duplicate = await send({ email, password, name: 'Другое имя' });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'EMAIL_EXISTS');
    assert.equal(duplicate.headers.get('set-cookie'), null);
    const invalid = await send({ email, password: 'SHORT', name: 'Имя' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('set-cookie'), null);
    for (const secret of [password, token, row.password_hash, config.password]) assert.ok(!adapter.output().includes(secret));
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
  } finally {
    if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
    await database.pool.query('DELETE FROM public.users WHERE email=$1', [email]);
    await database.close();
  }
});

test('running Node logs in with normalized email, rotates cookies and gives identical safe credential errors', async () => {
  const database = createDatabase(), email = randomUUID() + '@example.test';
  const password = '  P10 process fixture password 🔑  ';
  let adapter;
  try {
    adapter = await startAdapter();
    assert.ok(adapter.url, adapter.output());
    const send = (action, body, cookie) => fetch(adapter.url + '/api/auth/' + action, {
      method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const registered = await send('register', { email, password, name: 'P10 пользователь' });
    assert.equal(registered.status, 201);
    const oldCookie = registered.headers.get('set-cookie').split(';')[0];
    const profile = (await registered.json()).user;
    const loggedIn = await send('login', { email: ' ' + email.toUpperCase() + ' ', password }, oldCookie);
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await loggedIn.json(), { user: profile });
    let cookie = loggedIn.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, oldCookie);
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: oldCookie } })).status, 401);
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: cookie } })).status, 501);
    const errors = [];
    for (const body of [{ email, password: 'Wrong P10 fixture password' }, { email: randomUUID() + '@example.test', password }]) {
      const response = await send('login', body, cookie);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      errors.push(await response.text());
    }
    assert.equal(errors[0], errors[1]);
    assert.equal(JSON.parse(errors[0]).error.code, 'INVALID_CREDENTIALS');
    const again = await send('login', { email, password }, cookie);
    assert.equal(again.status, 200);
    const nextCookie = again.headers.get('set-cookie').split(';')[0];
    assert.notEqual(nextCookie, cookie);
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: nextCookie } })).status, 501);
    const hash = (await database.pool.query('SELECT password_hash FROM public.users WHERE email=$1', [email])).rows[0].password_hash;
    for (const secret of [password, hash, readSessionToken(oldCookie), readSessionToken(cookie), readSessionToken(nextCookie), config.password]) {
      assert.ok(!adapter.output().includes(secret));
      assert.ok(!errors.join('').includes(secret));
    }
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
  } finally {
    if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
    await database.pool.query('DELETE FROM public.users WHERE email=$1', [email]);
    await database.close();
  }
});

test('P11 running Node preserves the profile across restart, logs out one device and rejects expired sessions', async () => {
  const database = createDatabase(), id = randomUUID(), email = id + '@example.test';
  const sessions = createSessionService({ database, config: readAuthConfig({ PUBLIC_ORIGIN: publicOrigin, SESSION_TTL_SECONDS: '300' }) });
  let adapter;
  const output = [];
  try {
    await database.pool.query('INSERT INTO public.users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)',
      [id, email, '<b>P11 профиль</b>', 'scrypt$P11_PROCESS_SECRET']);
    const current = await sessions.issue(id), other = await sessions.issue(id);
    const cookie = current.cookie.split(';')[0], otherCookie = other.cookie.split(';')[0];
    const stored = (await database.pool.query('SELECT * FROM public.sessions WHERE id=$1', [current.id])).rows[0];
    adapter = await startAdapter();
    assert.ok(adapter.url, adapter.output());
    const me = value => fetch(adapter.url + '/api/auth/me', { headers: value ? { Cookie: value } : {} });
    const logout = value => fetch(adapter.url + '/api/auth/logout', { method: 'POST', headers: { Origin: publicOrigin, ...(value ? { Cookie: value } : {}) } });
    assert.deepEqual(await (await me()).json(), { user: null });
    const response = await me(cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: { id, email, name: '<b>P11 профиль</b>' } });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    await database.pool.query('UPDATE public.users SET name=$1 WHERE id=$2', ['P11 после обновления', id]);
    assert.equal((await (await me(cookie)).json()).user.name, 'P11 после обновления');
    assert.deepEqual((await database.pool.query('SELECT * FROM public.sessions WHERE id=$1', [current.id])).rows[0], stored);
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
    output.push(adapter.output());
    adapter = await startAdapter();
    assert.ok(adapter.url, adapter.output());
    assert.equal((await (await me(cookie)).json()).user.name, 'P11 после обновления');
    for (const value of [cookie, cookie, undefined]) {
      const ended = await logout(value);
      assert.equal(ended.status, 204);
      assert.equal(await ended.text(), '');
      assert.match(ended.headers.get('set-cookie'), /^am_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Path=\/$/);
      assert.equal(ended.headers.get('cache-control'), 'private, no-store');
    }
    assert.deepEqual(await (await me(cookie)).json(), { user: null });
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await (await me(otherCookie)).json()).user.id, id);
    await database.pool.query("UPDATE public.sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours', expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1", [other.id]);
    assert.deepEqual(await (await me(otherCookie)).json(), { user: null });
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: otherCookie } })).status, 401);
    assert.equal((await logout(otherCookie)).status, 204);
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM public.sessions WHERE user_id=$1', [id])).rows[0].n, 1); // Explicit maintenance only.
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
    output.push(adapter.output());
    for (const secret of ['scrypt$P11_PROCESS_SECRET', readSessionToken(cookie), readSessionToken(otherCookie), config.password]) {
      assert.ok(!output.join('').includes(secret));
    }
  } finally {
    if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
    await database.pool.query('DELETE FROM public.users WHERE id=$1', [id]);
    await database.close();
  }
});

test('P12 running Node limits auth attempts, recovers by wall time, distrusts spoofed headers and keeps logs free of secrets', async () => {
  const database = createDatabase(), id = randomUUID(), email = id + '@example.test';
  const password = '  P12 process fixture password 🔑  ', hash = await hashPassword(password);
  const registrationEmails = [randomUUID() + '@example.test', randomUUID() + '@example.test'];
  const sessions = createSessionService({ database, config: readAuthConfig({ PUBLIC_ORIGIN: publicOrigin, SESSION_TTL_SECONDS: '300' }) });
  let adapter;
  const outputs = [], tokens = [];
  try {
    await database.pool.query('INSERT INTO public.users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)', [id, email, 'P12 process', hash]);
    const active = await sessions.issue(id);
    let currentCookie = active.cookie.split(';')[0];
    tokens.push(readSessionToken(currentCookie));
    adapter = await startAdapter({ AUTH_WINDOW_SECONDS: '3', AUTH_LOGIN_MAX_ATTEMPTS: '1', AUTH_REGISTER_MAX_ATTEMPTS: '1', TRUSTED_PROXY_CIDRS: '' });
    assert.ok(adapter.url, adapter.output());
    const send = (action, body, extra = {}) => fetch(adapter.url + '/api/auth/' + action, {
      method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
    const wrong = { email, password: 'Wrong P12 process password' };
    assert.equal((await send('login', wrong, { 'X-Forwarded-For': '198.51.100.1' })).status, 401);
    const blocked = await send('login', { email: ' ' + email.toUpperCase() + ' ', password }, { Cookie: currentCookie, 'X-Forwarded-For': '198.51.100.2' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('set-cookie'), null);
    const retry = Number(blocked.headers.get('retry-after'));
    assert.ok(retry >= 1 && retry <= 3);
    assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
    assert.equal(blocked.headers.get('cache-control'), 'private, no-store');
    const registered = await send('register', { email: registrationEmails[0], password, name: 'P12 rate fixture' });
    assert.equal(registered.status, 201);
    const registrationCookie = registered.headers.get('set-cookie').split(';')[0];
    tokens.push(readSessionToken(registrationCookie));
    assert.equal((await send('register', { email: registrationEmails[1], password, name: 'P12 blocked' }, { 'X-Forwarded-For': '203.0.113.9' })).status, 429);
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM public.users WHERE email=$1', [registrationEmails[1]])).rows[0].n, 0);
    assert.equal((await (await fetch(adapter.url + '/api/auth/me', { headers: { Cookie: currentCookie } })).json()).user.id, id);
    const logout = await fetch(adapter.url + '/api/auth/logout', { method: 'POST', headers: { Origin: publicOrigin, Cookie: currentCookie } });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(adapter.url + '/api/images', { headers: { Cookie: currentCookie } })).status, 401);
    await delay(retry * 1000 + 30);
    const restored = await send('login', { email, password });
    assert.equal(restored.status, 200);
    currentCookie = restored.headers.get('set-cookie').split(';')[0];
    tokens.push(readSessionToken(currentCookie));
    const afterSuccess = await send('login', { email, password });
    assert.equal(afterSuccess.status, 429); // Successful login also consumes its slot.
    assert.equal(afterSuccess.headers.get('set-cookie'), null);
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
    outputs.push(adapter.output());
    adapter = await startAdapter({ AUTH_WINDOW_SECONDS: '10', AUTH_LOGIN_MAX_ATTEMPTS: '1', AUTH_REGISTER_MAX_ATTEMPTS: '1', TRUSTED_PROXY_CIDRS: '127.0.0.1/32,10.0.0.0/8' });
    assert.ok(adapter.url, adapter.output());
    // Same TCP/email key is allowed after restart; persisted session still works.
    assert.equal((await (await fetch(adapter.url + '/api/auth/me', { headers: { Cookie: currentCookie } })).json()).user.id, id);
    const afterRestart = await send('login', { email, password }, { Cookie: currentCookie });
    assert.equal(afterRestart.status, 200);
    tokens.push(readSessionToken(afterRestart.headers.get('set-cookie').split(';')[0]));
    for (let n = 0; n < 2; n++) {
      const response = await send('login', wrong, { 'X-Forwarded-For': `203.0.113.${n + 1}, 198.51.100.9, 10.0.0.2` });
      assert.equal(response.status, n === 0 ? 401 : 429);
    }
    assert.equal((await send('login', wrong, { 'X-Forwarded-For': '198.51.100.8,10.0.0.2' })).status, 401);
    adapter.child.kill('SIGTERM');
    assert.deepEqual(await adapter.exited, [0, null]);
    outputs.push(adapter.output());
    for (const secret of [password, wrong.password, hash, ...tokens, process.env.TEST_DATABASE_URL, config.password, registrationCookie]) {
      assert.ok(!outputs.join('').includes(secret));
    }
  } finally {
    if (adapter?.child.exitCode === null) { adapter.child.kill('SIGKILL'); await adapter.exited; }
    await database.pool.query('DELETE FROM public.users WHERE id=$1 OR email=ANY($2::text[])', [id, registrationEmails]);
    await database.close();
  }
});
