import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService, readSessionToken } from '../../src/backend/sessions.mjs';
import { createAuthenticationGuard } from '../../src/backend/authentication.mjs';
import { createNodeApiHandler } from '../../src/backend/router.mjs';
import { Readable } from 'node:stream';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const config = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test', SESSION_TTL_SECONDS: '300' });
const headersFor = session => new Headers({ cookie: session.cookie.split(';')[0] });

async function isolated(fn) {
  const database = createDatabase();
  const schema = 'p08_test_' + randomUUID().replaceAll('-', '');
  let pool;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const service = createSessionService({ database: { pool }, config });
    const user = async () => (await pool.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING *',
      [randomUUID() + '@example.test', '<b>Имя P08</b>', 'scrypt$P08_TEST_ONLY'])).rows[0];
    await fn({ pool, service, user });
  } finally {
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

test('P08 issues distinct opaque tokens, stores only SHA-256 and resolves after service recreation without renewal', async () => {
  await isolated(async ({ pool, service, user }) => {
    const owner = await user();
    const first = await service.issue(owner.id), second = await service.issue(owner.id);
    const one = readSessionToken(first.cookie.split(';')[0]), two = readSessionToken(second.cookie.split(';')[0]);
    assert.equal(Buffer.from(one, 'base64url').length, 32);
    assert.notEqual(one, two);
    const row = (await pool.query('SELECT * FROM sessions WHERE id=$1', [first.id])).rows[0];
    assert.deepEqual(row.token_hash, createHash('sha256').update(one, 'ascii').digest());
    assert.equal(row.token_hash.length, 32);
    assert.equal(row.expires_at - row.created_at, 300000);
    assert.ok(!JSON.stringify(row).includes(one));
    assert.match(first.cookie, /; Secure$/);
    const restarted = createSessionService({ database: { pool }, config });
    const auth = await restarted.resolve(headersFor(first));
    assert.deepEqual(auth.user, { id: owner.id, email: owner.email, name: owner.name });
    assert.equal(auth.session.id, first.id);
    assert.equal(auth.session.expiresAt.toISOString(), first.expiresAt.toISOString());
    assert.ok(!JSON.stringify(auth).includes(one));
    assert.doesNotMatch(JSON.stringify(auth), /password_hash|token_hash/);
    const after = (await pool.query('SELECT * FROM sessions WHERE id=$1', [first.id])).rows[0];
    assert.deepEqual(after, row);
  });
});

test('missing, forged, altered and expired sessions fail closed using the database expiry', async () => {
  await isolated(async ({ pool, service, user }) => {
    const owner = await user(), session = await service.issue(owner.id);
    const original = readSessionToken(session.cookie.split(';')[0]);
    const altered = (original[0] === 'A' ? 'B' : 'A') + original.slice(1);
    assert.equal(await service.resolve(new Headers()), null);
    assert.equal(await service.resolve(new Headers({ cookie: 'am_session=' + session.id })), null);
    assert.equal(await service.resolve(new Headers({ cookie: 'am_session=' + randomBytes(32).toString('base64url') })), null);
    assert.equal(await service.resolve(new Headers({ cookie: 'am_session=' + altered })), null);
    await pool.query("UPDATE sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours', expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1", [session.id]);
    const expired = new Headers({ cookie: session.cookie.split(';')[0] + '; Max-Age=604800' });
    assert.equal(await service.resolve(expired), null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1); // Cleanup is P11, not a GET side effect.
  });
});

test('revocation is idempotent and leaves another device session active', async () => {
  await isolated(async ({ service, user }) => {
    const owner = await user();
    const first = await service.issue(owner.id), other = await service.issue(owner.id);
    assert.equal(await service.revoke(first.id), true);
    assert.equal(await service.revoke(first.id), false);
    assert.equal(await service.resolve(headersFor(first)), null);
    assert.equal((await service.resolve(headersFor(other))).user.id, owner.id);
  });
});

test('session replacement is atomic, supports a caller transaction and can change accounts', async () => {
  await isolated(async ({ pool, service, user }) => {
    const a = await user(), b = await user();
    const previous = await service.issue(a.id), otherDevice = await service.issue(a.id);
    const client = await pool.connect();
    let provisional;
    try {
      await client.query('BEGIN');
      provisional = await service.issue(b.id, { client, replaceSessionId: previous.id });
      assert.equal((await service.resolve(headersFor(previous))).user.id, a.id);
      assert.equal(await service.resolve(headersFor(provisional)), null);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await service.resolve(headersFor(previous))).user.id, a.id);
    assert.equal(await service.resolve(headersFor(provisional)), null);
    await assert.rejects(service.issue(randomUUID(), { replaceSessionId: previous.id }), { code: 'DATABASE_UNAVAILABLE' });
    assert.equal((await service.resolve(headersFor(previous))).user.id, a.id);
    const replacement = await service.issue(b.id, { replaceSessionId: previous.id });
    assert.equal(await service.resolve(headersFor(previous)), null);
    assert.equal((await service.resolve(headersFor(replacement))).user.id, b.id);
    assert.equal((await service.resolve(headersFor(otherDevice))).user.id, a.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 2);
  });
});

test('a failed pg pool returns safe 503 through the auth guard instead of a fake guest', async () => {
  await isolated(async ({ service, user }) => {
    const session = await service.issue((await user()).id);
    const pool = new Pool(databaseConfig);
    await pool.end();
    const unavailable = createSessionService({ database: { pool }, config });
    const handle = createNodeApiHandler({ beforeHandle: createAuthenticationGuard({ sessions: unavailable, config }) });
    const token = readSessionToken(session.cookie.split(';')[0]);
    for (const path of ['/api/auth/me', '/api/images']) {
      const incoming = Object.assign(Readable.from([]), { method: 'GET', url: path, headers: { cookie: session.cookie.split(';')[0] } });
      const response = await handle(incoming);
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.equal(JSON.parse(body).error.code, 'DATABASE_UNAVAILABLE');
      assert.ok(!body.includes(token));
      assert.doesNotMatch(body, /password|SELECT|postgresql|pool|stack/);
    }
  });
});
