import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readAuthConfig, AuthConfigError } from '../src/backend/auth-config.mjs';
import { readSessionToken, sessionCookie, clearSessionCookie, createSessionService } from '../src/backend/sessions.mjs';
import { apiErrorResponse } from '../src/backend/http-errors.mjs';

const config = readAuthConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:3000', SESSION_TTL_SECONDS: '300' });
const token = () => randomBytes(32).toString('base64url');
const cookieHeaders = value => new Headers({ cookie: 'am_session=' + value });

test('auth configuration requires a canonical trusted origin and HTTPS in production', () => {
  assert.deepEqual(readAuthConfig({ PUBLIC_ORIGIN: 'http://[::1]:3000' }), { publicOrigin: 'http://[::1]:3000', secure: false, ttlSeconds: 604800 });
  assert.deepEqual(readAuthConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://map.example.test' }), { publicOrigin: 'https://map.example.test', secure: true, ttlSeconds: 604800 });
  assert.equal(Object.isFrozen(config), true);
  for (const origin of [undefined, '', 'null', 'TOP_SECRET', 'ftp://example.test', 'https://user:TOP_SECRET@example.test',
    'https://example.test/', 'https://example.test/path', 'https://example.test?secret=TOP_SECRET',
    'https://example.test#TOP_SECRET', ' https://example.test', 'https://EXAMPLE.test', 'https://example.test:443']) {
    assert.throws(() => readAuthConfig({ PUBLIC_ORIGIN: origin }), error => {
      assert.ok(error instanceof AuthConfigError);
      assert.equal(error.code, 'AUTH_CONFIG_INVALID');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET/);
      return true;
    });
  }
  assert.throws(() => readAuthConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost' }), /HTTPS/);
  assert.throws(() => readAuthConfig({ NODE_ENV: 'TOP_SECRET', PUBLIC_ORIGIN: 'https://example.test' }), AuthConfigError);
});

test('session lifetime is an integer in 300–604800 seconds', () => {
  for (const ttl of ['300', '604800']) assert.equal(readAuthConfig({ PUBLIC_ORIGIN: config.publicOrigin, SESSION_TTL_SECONDS: ttl }).ttlSeconds, Number(ttl));
  for (const ttl of ['', '0', '299', '604801', '-1', '1.5', '3e2', ' 300', '0300', '999999999999999999', 'TOP_SECRET', 300]) {
    assert.throws(() => readAuthConfig({ PUBLIC_ORIGIN: config.publicOrigin, SESSION_TTL_SECONDS: ttl }), error => {
      assert.equal(error.code, 'AUTH_CONFIG_INVALID');
      assert.doesNotMatch(error.message, /TOP_SECRET/);
      return true;
    });
  }
});

test('cookie parser accepts only one canonical 32-byte session token', () => {
  const value = token();
  assert.equal(Buffer.from(value, 'base64url').length, 32);
  assert.equal(readSessionToken('other=1; am_session=' + value + '; theme=dark'), value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) + 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(value, 'base64url'));
  for (const cookie of [undefined, '', 'not_am_session=' + value, 'am_session', 'am_session=', 'am_session="' + value + '"',
    'am_session=' + value + '=', 'am_session=' + alias, 'am_session=TOP_SECRET', 'am_session=%' + value,
    'am_session=' + value + '; am_session=' + value, 'am_session; am_session=' + value]) {
    assert.equal(readSessionToken(cookie), null);
  }
});

test('issued and cleared cookies share HttpOnly, SameSite, Path and HTTPS Secure policy', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const expires = new Date(now + 300000), value = token();
  const cookie = sessionCookie(value, expires, config, now);
  assert.match(cookie, /^am_session=[A-Za-z0-9_-]{43}; Max-Age=300; Expires=Wed, 11 Nov 2026 12:05:00 GMT/);
  assert.match(cookie, /; HttpOnly; SameSite=Lax; Path=\/$/);
  assert.doesNotMatch(cookie, /Secure|Domain/);
  assert.match(sessionCookie(value, expires, { ...config, secure: true }, now + 1999), /Max-Age=298;.*; Secure$/);
  assert.match(sessionCookie(value, new Date(now + 900000), config, now), /Max-Age=300;/);
  assert.match(sessionCookie(value, new Date(now - 1), config, now), /Max-Age=0;/);
  for (const secure of [false, true]) {
    const cleared = clearSessionCookie({ ...config, secure });
    assert.match(cleared, /^am_session=; Max-Age=0; Expires=Thu, 01 Jan 1970/);
    assert.match(cleared, /; HttpOnly; SameSite=Lax; Path=\//);
    assert.equal(cleared.endsWith('; Secure'), secure);
    assert.doesNotMatch(cleared, /Domain/);
  }
  assert.throws(() => sessionCookie('TOP_SECRET', expires, config, now), { code: 'INTERNAL_ERROR' });
  assert.throws(() => sessionCookie(value, null, config, now), { code: 'INTERNAL_ERROR' });
});

test('session issuance generates new tokens but passes only digests and trusted values to SQL', async () => {
  const calls = [];
  const service = createSessionService({ config, database: { pool: { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ id: 'server-session', user_id: values[0], expires_at: new Date(Date.now() + 300000) }] };
  } } } });
  const first = await service.issue('server-user');
  const second = await service.issue('server-user', { replaceSessionId: first.id });
  const one = readSessionToken(first.cookie.split(';')[0]), two = readSessionToken(second.cookie.split(';')[0]);
  assert.notEqual(one, two);
  for (let i = 0; i < calls.length; i++) {
    const value = [one, two][i];
    assert.deepEqual(calls[i].values[1], createHash('sha256').update(value, 'ascii').digest());
    assert.equal(calls[i].values[1].length, 32);
    assert.equal(calls[i].values[2], 300);
    assert.ok(!calls[i].sql.includes(value));
    assert.ok(!JSON.stringify(calls[i].values).includes(value));
  }
  assert.equal(calls[0].values[3], null);
  assert.equal(calls[1].values[3], first.id);
  assert.equal(first.token, undefined);
});

test('caller-owned transaction clients are used for issue/revoke without commits or releases', async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    return { rowCount: 1, rows: [{ id: 'session', user_id: 'user', expires_at: new Date(Date.now() + 300000) }] };
  } };
  const service = createSessionService({ config, database: { pool: { query() { throw new Error('Wrong pool'); } } } });
  await service.issue('user', { client });
  assert.equal(await service.revoke('session', { client }), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].values, ['session']);
  assert.doesNotMatch(calls.map(c => c.sql).join('\n'), /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/);
});

test('session resolution reads only a digest and returns a safe identity without token/hash', async () => {
  const value = token();
  let calls = 0;
  const service = createSessionService({ config, database: { pool: { async query(sql, values) {
    calls++;
    assert.deepEqual(values, [createHash('sha256').update(value, 'ascii').digest()]);
    return { rows: [{ id: 'user-id', email: 'a@example.test', name: 'Имя', session_id: 'session-id', expires_at: new Date(), password_hash: 'TOP_SECRET_HASH' }] };
  } } } });
  for (const headers of [new Headers(), cookieHeaders('forged'), new Headers({ cookie: 'am_session=' + value + '; am_session=' + value })]) {
    assert.equal(await service.resolve(headers), null);
  }
  assert.equal(calls, 0);
  const auth = await service.resolve(cookieHeaders(value));
  assert.deepEqual(auth.user, { id: 'user-id', email: 'a@example.test', name: 'Имя' });
  assert.equal(auth.session.id, 'session-id');
  assert.ok(!JSON.stringify(auth).includes(value));
  assert.doesNotMatch(JSON.stringify(auth), /TOP_SECRET_HASH|token|password/);
  assert.equal(calls, 1);
});

test('database failures stay 503 without leaking tokens, SQL, or connection details', async () => {
  const value = token();
  const service = createSessionService({ config, database: { pool: { query() { throw new Error('SELECT TOP_SECRET postgresql://user:password@db ' + value); } } } });
  for (const operation of [() => service.resolve(cookieHeaders(value)), () => service.issue('user'), () => service.revoke('session')]) {
    await assert.rejects(operation(), asyncError => {
      assert.equal(asyncError.code, 'DATABASE_UNAVAILABLE');
      assert.doesNotMatch(asyncError.stack + JSON.stringify(asyncError), /TOP_SECRET|SELECT|postgresql/);
      assert.ok(!asyncError.stack.includes(value));
      return true;
    });
  }
  try { await service.resolve(cookieHeaders(value)); }
  catch (error) {
    const response = apiErrorResponse(error);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
  }
});
