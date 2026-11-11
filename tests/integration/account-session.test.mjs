import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
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
import { createMeHandler, createLogoutHandler } from '../../src/backend/account-session.mjs';
import { cleanupExpiredSessions } from '../../src/backend/session-cleanup.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const config = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test', SESSION_TTL_SECONDS: '300' });
const cookie = session => session.cookie.split(';')[0];
const expire = (pool, id) => pool.query("UPDATE sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours', expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1", [id]);

async function isolated(fn, { unavailable = false } = {}) {
  const database = createDatabase(), schema = 'p11_test_' + randomUUID().replaceAll('-', '');
  let pool, server;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config });
    let httpSessions = sessions;
    if (unavailable) {
      const closedPool = new Pool(databaseConfig);
      await closedPool.end();
      httpSessions = createSessionService({ database: { pool: closedPool }, config });
    }
    server = http.createServer(createRequestHandler({ worker, nodeApi: createNodeApiHandler({
      database: { pool }, beforeHandle: createAuthenticationGuard({ sessions: httpSessions, config }),
      handlers: { 'auth.me': createMeHandler(), 'auth.logout': createLogoutHandler({ sessions: httpSessions, config }) },
    }) }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const call = (path, init = {}) => fetch(url + path, { ...init, signal: AbortSignal.timeout(5000) });
    const me = session => call('/api/auth/me', { headers: session ? { Cookie: cookie(session) } : {} });
    const logout = session => call('/api/auth/logout', { method: 'POST', headers: { Origin: config.publicOrigin, ...(session ? { Cookie: cookie(session) } : {}) } });
    const user = async () => (await pool.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING *',
      [randomUUID() + '@example.test', '<b>Профиль P11</b>', 'scrypt$P11_TEST_ONLY'])).rows[0];
    await fn({ pool, sessions, call, me, logout, user });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

test('P11 HTTP me reads the current public profile without renewing, modifying or exposing the session', async () => {
  await isolated(async ({ pool, sessions, me, user }) => {
    const owner = await user(), current = await sessions.issue(owner.id);
    const before = (await pool.query('SELECT * FROM sessions WHERE id=$1', [current.id])).rows[0];
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await me(current);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = await response.json();
      assert.deepEqual(body, { user: { id: owner.id, email: owner.email, name: owner.name } });
      assert.doesNotMatch(JSON.stringify(body), /password_hash|token_hash|expires_at|session_id|P11_TEST_ONLY/);
      assert.ok(!JSON.stringify(body).includes(readSessionToken(cookie(current))));
    }
    await pool.query('UPDATE users SET name=$1 WHERE id=$2', ['Обновлённое имя', owner.id]);
    assert.equal((await (await me(current)).json()).user.name, 'Обновлённое имя');
    assert.deepEqual((await pool.query('SELECT * FROM sessions WHERE id=$1', [current.id])).rows[0], before);
  });
});

test('missing, malformed, forged, duplicate, revoked, expired and deleted-user cookies give an explicit guest', async () => {
  await isolated(async ({ pool, sessions, call, me, user }) => {
    const owner = await user(), current = await sessions.issue(owner.id);
    const deletedOwner = await user(), deleted = await sessions.issue(deletedOwner.id);
    await pool.query('DELETE FROM users WHERE id=$1', [deletedOwner.id]);
    const revoked = await sessions.issue(owner.id);
    await sessions.revoke(revoked.id);
    await expire(pool, current.id);
    for (const value of [undefined, 'am_session=', 'am_session=forged', 'am_session=' + randomBytes(32).toString('base64url'),
      cookie(current) + '; ' + cookie(current), cookie(current), cookie(revoked), cookie(deleted)]) {
      const headers = value ? { Cookie: value } : {};
      const response = await call('/api/auth/me', { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { user: null });
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal((await call('/api/images', { headers })).status, 401);
    }
    assert.deepEqual(await (await me()).json(), { user: null });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1); // No GET cleanup.
    assert.equal(await cleanupExpiredSessions({ pool }), 1);
    assert.equal(await cleanupExpiredSessions({ pool }), 0);
    assert.deepEqual(await (await me(current)).json(), { user: null });
  });
});

test('HTTP logout revokes only the current device and repeated/guest logout clears the cookie with an empty 204', async () => {
  await isolated(async ({ sessions, call, me, logout, user }) => {
    const owner = await user(), current = await sessions.issue(owner.id), other = await sessions.issue(owner.id);
    for (const session of [current, current, undefined, { cookie: 'am_session=forged' }]) {
      const response = await logout(session);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('content-type'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('set-cookie'), /^am_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
      assert.deepEqual(await (await me(current)).json(), { user: null });
      assert.equal((await call('/api/images', { headers: { Cookie: cookie(current) } })).status, 401);
      assert.equal((await (await me(other)).json()).user.id, owner.id);
    }
  });
});

test('logout rejects foreign Origin, bodies and wrong methods without revoking the session or clearing the cookie', async () => {
  await isolated(async ({ sessions, call, me, user }) => {
    const owner = await user(), current = await sessions.issue(owner.id);
    for (const init of [
      { method: 'POST', headers: { Origin: 'https://evil.test' } },
      { method: 'POST', headers: {} },
      { method: 'GET', headers: {} },
      { method: 'POST', headers: { Origin: config.publicOrigin }, body: 'x' },
    ]) {
      const response = await call('/api/auth/logout', { ...init, headers: { Cookie: cookie(current), ...init.headers } });
      assert.equal(response.status, init.body ? 413 : init.method === 'GET' ? 405 : 403);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal((await (await me(current)).json()).user.id, owner.id);
    }
  });
});

test('failed DELETE returns safe 503 without clearing the cookie; retry can revoke the preserved session', async () => {
  await isolated(async ({ pool, sessions, me, logout, user }) => {
    const owner = await user(), current = await sessions.issue(owner.id);
    await pool.query(`CREATE FUNCTION reject_logout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P11_SECRET_SQL'; END $$;
      CREATE TRIGGER reject_logout BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_logout()`);
    const response = await logout(current);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'DATABASE_UNAVAILABLE');
    assert.doesNotMatch(body, /P11_SECRET_SQL|DELETE|stack|postgresql|password/);
    assert.ok(!body.includes(readSessionToken(cookie(current))));
    assert.equal((await (await me(current)).json()).user.id, owner.id);
    await pool.query('DROP TRIGGER reject_logout ON sessions');
    assert.equal((await logout(current)).status, 204);
    assert.deepEqual(await (await me(current)).json(), { user: null });
  });
});

test('a database outage gives 503 for a canonical cookie instead of a fake guest or successful logout', async () => {
  await isolated(async ({ sessions, me, logout, user }) => {
    const current = await sessions.issue((await user()).id);
    for (const response of [await me(current), await logout(current)]) {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }, { unavailable: true });
});

test('explicit cleanup is bounded to 1000 expired rows, preserves active sessions and account/layer data', async () => {
  await isolated(async ({ pool, sessions, user }) => {
    const owner = await user(), active = await sessions.issue(owner.id);
    await pool.query('INSERT INTO layer_settings (user_id,opacity) VALUES ($1,.4)', [owner.id]);
    const settings = (await pool.query('SELECT * FROM layer_settings')).rows[0];
    await pool.query(`INSERT INTO sessions (user_id,token_hash,created_at,expires_at)
      SELECT $1,decode(lpad(to_hex(n),64,'0'),'hex'),CURRENT_TIMESTAMP-INTERVAL '2 hours',CURRENT_TIMESTAMP-INTERVAL '1 hour'
      FROM generate_series(1,1003) AS n`, [owner.id]);
    assert.equal(await cleanupExpiredSessions({ pool }), 1000);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 4);
    assert.equal(await cleanupExpiredSessions({ pool }), 3);
    assert.equal(await cleanupExpiredSessions({ pool }), 0);
    assert.equal((await sessions.resolve(new Headers({ Cookie: cookie(active) }))).user.id, owner.id);
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows[0], owner);
    assert.deepEqual((await pool.query('SELECT * FROM layer_settings')).rows[0], settings);
  });
});

test('cleanup skips a locked expired session and removes it on the next run after the lock is released', async () => {
  await isolated(async ({ pool, sessions, user }) => {
    const owner = await user(), locked = await sessions.issue(owner.id), unlocked = await sessions.issue(owner.id);
    await expire(pool, locked.id);
    await expire(pool, unlocked.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [locked.id]);
      assert.equal(await cleanupExpiredSessions({ pool }), 1);
      assert.deepEqual((await pool.query('SELECT id FROM sessions')).rows.map(row => row.id), [locked.id]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal(await cleanupExpiredSessions({ pool }), 1);
    assert.equal(await cleanupExpiredSessions({ pool }), 0);
  });
});
