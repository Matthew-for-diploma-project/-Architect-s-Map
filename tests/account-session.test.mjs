import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMeHandler, createLogoutHandler } from '../src/backend/account-session.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';
import { createAuthenticationGuard } from '../src/backend/authentication.mjs';
import { ApiError } from '../src/backend/http-errors.mjs';

const run = promisify(execFile);
const config = { publicOrigin: 'https://map.example.test', secure: true };
const auth = { user: { id: 'server-user', email: 'a@example.test', name: '<b>Имя</b>', password_hash: 'SECRET_HASH' }, session: { id: 'server-session' } };
const incoming = (method, url, headers = {}, chunks = []) => Object.assign(Readable.from(chunks), { method, url, headers });
function router(sessions, trustedConfig = config) {
  return createNodeApiHandler({
    beforeHandle: createAuthenticationGuard({ sessions, config: trustedConfig }),
    handlers: { 'auth.me': createMeHandler(), 'auth.logout': createLogoutHandler({ sessions, config: trustedConfig }) },
  });
}

test('P11 me returns an explicit guest or only the verified public profile without setting a cookie', async () => {
  for (const identity of [null, auth]) {
    const handle = router({ resolve: async () => identity });
    const response = await handle(incoming('GET', '/api/auth/me?userId=forged', { 'x-user-id': 'forged' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: identity ? { id: 'server-user', email: 'a@example.test', name: '<b>Имя</b>' } : null });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('logout waits for revocation and clears the same cookie policy only after success', async () => {
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const revoked = new Promise(resolve => { finish = resolve; });
  const ids = [];
  const handle = router({ resolve: async () => auth, async revoke(id) { ids.push(id); started(); await revoked; } });
  let settled = false;
  const pending = handle(incoming('POST', '/api/auth/logout', { origin: config.publicOrigin })).then(response => { settled = true; return response; });
  await began;
  assert.equal(settled, false);
  finish();
  const response = await pending;
  assert.deepEqual(ids, ['server-session']);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-type'), null);
  assert.match(response.headers.get('set-cookie'), /^am_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('guest and repeated logout both return an empty 204 with cookie clearing and no revocation', async () => {
  for (const secure of [false, true]) {
    const handle = router({ resolve: async () => null, revoke() { throw new Error('No active session to revoke'); } }, { ...config, secure });
    for (let i = 0; i < 2; i++) {
      const response = await handle(incoming('POST', '/api/auth/logout', { origin: config.publicOrigin, cookie: 'am_session=invalid' }));
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      assert.match(response.headers.get('set-cookie'), /^am_session=; Max-Age=0;/);
      assert.equal(response.headers.get('set-cookie').endsWith('; Secure'), secure);
    }
  }
});

test('logout preserves Origin, method and empty-body checks before revocation', async () => {
  let resolved = 0, revoked = 0;
  const handle = router({ resolve: async () => { resolved++; return auth; }, revoke() { revoked++; } });
  for (const origin of [undefined, 'null', 'https://evil.test']) {
    const request = incoming('POST', '/api/auth/logout', origin ? { origin } : {}, ['unread']);
    assert.equal((await handle(request)).status, 403);
    assert.equal(request.readableFlowing, null);
  }
  assert.equal((await handle(incoming('GET', '/api/auth/logout'))).status, 405);
  assert.equal(resolved, 0);
  for (const path of ['/api/auth/me', '/api/auth/logout']) {
    const response = await handle(incoming(path.endsWith('me') ? 'GET' : 'POST', path, { origin: config.publicOrigin }, ['x']));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(revoked, 0);
});

test('lookup and revocation failures return safe 503 without a fake guest or cleared cookie', async () => {
  for (const stage of ['resolve', 'revoke']) {
    const handle = router({
      resolve: async () => { if (stage === 'resolve') throw new ApiError('DATABASE_UNAVAILABLE'); return auth; },
      revoke: async () => { throw new ApiError('DATABASE_UNAVAILABLE'); },
    });
    for (const path of stage === 'resolve' ? ['/api/auth/me', '/api/auth/logout'] : ['/api/auth/logout']) {
      const response = await handle(incoming(path.endsWith('me') ? 'GET' : 'POST', path, { origin: config.publicOrigin }));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
});

test('session maintenance CLI rejects mixed test modes before connecting and supports offline help', async () => {
  const script = 'tools/cleanup-sessions.mjs';
  const clean = { PATH: process.env.PATH };
  assert.match((await run(process.execPath, [script, '--help'], { env: clean })).stdout, /1000/);
  for (const [mode, args] of [['test', []], ['development', ['--test']], ['test', ['--test', '--extra']], ['development', ['--unknown']]]) {
    await assert.rejects(run(process.execPath, [script, ...args], { env: { ...clean, NODE_ENV: mode, DATABASE_URL: 'SECRET_CONNECTION' }, timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--test/);
      assert.doesNotMatch(error.stdout + error.stderr, /SECRET_CONNECTION|postgresql|password/);
      return true;
    });
  }
});
