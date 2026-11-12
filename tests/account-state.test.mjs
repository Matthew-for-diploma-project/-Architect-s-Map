import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAccountState, AccountApiError } from '../src/account-state.js';

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'имя@пример.рф', name: '<b>Анна</b>' };
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const failure = (status, code, fields) => json({ error: { code, message: 'Запрос не выполнен.', fields } }, status);

test('session starts unknown, resolves me with same-origin/no-store, and exposes only a public profile', async () => {
  const calls = [];
  const account = createAccountState({ fetchImpl: async (...args) => { calls.push(args); return json({ user: { ...user, password_hash: 'never-expose' } }); } });
  assert.equal(account.getState().phase, 'loading');
  assert.equal(account.canUsePersonalActions(), false);
  const states = [];
  const unsubscribe = account.subscribe(state => states.push(state));
  await account.refresh();
  assert.deepEqual(account.getState().user, user);
  assert.equal(account.getState().phase, 'authenticated');
  assert.equal(account.canUsePersonalActions(), true);
  const [url, options] = calls[0];
  assert.equal(url, '/api/auth/me');
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.body, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(states).includes('never-expose'), false);
  assert.ok(Object.isFrozen(account.getState().user));
  unsubscribe();
});

test('network failure is an unresolved error, never a guest; retry can restore either session state', async () => {
  let mode = 'offline';
  const account = createAccountState({ fetchImpl: async () => {
    if (mode === 'offline') throw new Error('private driver detail');
    return json({ user: mode === 'guest' ? null : user });
  } });
  await assert.rejects(account.refresh(), error => error instanceof AccountApiError && !error.message.includes('private'));
  assert.equal(account.getState().phase, 'error');
  assert.equal(account.canUsePersonalActions(), false);
  mode = 'guest'; await account.refresh();
  assert.equal(account.getState().phase, 'guest');
  mode = 'user'; await account.refresh();
  assert.equal(account.getState().phase, 'authenticated');
});

test('registration sends exact password/allowed fields, prevents overlapping requests, and blocks personal actions until acknowledged', async () => {
  const calls = [], snapshots = [];
  let release;
  const password = '  😀😀😀😀😀😀😀😀😀😀😀😀  ';
  const account = createAccountState({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/me')) return json({ user: null });
    return new Promise(resolve => { release = () => resolve(json({ user }, 201)); });
  } });
  account.subscribe(state => snapshots.push(state));
  await account.refresh();
  const pending = account.authenticate('register', { email: user.email, name: user.name, password, owner: 'ignored' });
  assert.equal(account.getState().pending, 'register');
  assert.equal(account.canUsePersonalActions(), false);
  assert.equal(await account.authenticate('register', { email: 'other@x.test', password, name: 'B' }), null);
  assert.equal(await account.refresh(), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1][1].body), { email: user.email, password, name: user.name });
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  release(); await pending;
  assert.equal(account.getState().phase, 'authenticated');
  assert.equal(JSON.stringify(snapshots).includes(password), false);
});

test('credential/field/conflict/rate errors preserve a confirmed guest and return safe field/retry information', async () => {
  for (const [status, code, fields] of [[401, 'INVALID_CREDENTIALS'], [400, 'VALIDATION_ERROR', { email: 'Проверьте почту', owner: 'ignored' }], [409, 'EMAIL_EXISTS'], [429, 'RATE_LIMITED']]) {
    const account = createAccountState({ fetchImpl: async url => url.endsWith('/me') ? json({ user: null })
      : status === 429 ? json({ error: { code, message: 'Слишком много попыток.' } }, 429, { 'Retry-After': '7' }) : failure(status, code, fields) });
    await account.refresh();
    await assert.rejects(account.authenticate('login', { email: user.email, password: 'twelve chars' }), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.uncertain, false);
      assert.equal(error.fields.owner, undefined);
      if (status === 409) assert.equal(error.fields.email, error.message);
      if (status === 429) assert.match(error.message, /7 с/);
      return true;
    });
    assert.equal(account.getState().phase, 'guest');
  }
});

test('an ambiguous mutation cannot be retried until me reconciles a possibly committed session', async () => {
  let committed = false, posts = 0;
  const account = createAccountState({ fetchImpl: async url => {
    if (url.endsWith('/me')) return json({ user: committed ? user : null });
    posts++; committed = true;
    throw new Error('response lost');
  } });
  await account.refresh();
  await assert.rejects(account.authenticate('login', { email: user.email, password: 'twelve chars' }));
  assert.equal(account.getState().phase, 'error');
  assert.equal(account.canUsePersonalActions(), false);
  assert.equal(await account.authenticate('login', { email: user.email, password: 'twelve chars' }), null);
  assert.equal(posts, 1);
  await account.refresh();
  assert.equal(account.getState().phase, 'authenticated');
});

test('logout has no body, is single-flight, and a failed logout never produces a false guest', async () => {
  let response = failure(503, 'DATABASE_UNAVAILABLE'), calls = 0;
  const account = createAccountState({ fetchImpl: async (url, options) => {
    if (url.endsWith('/me')) return json({ user });
    calls++;
    assert.equal(options.method, 'POST');
    assert.equal(options.body, undefined);
    assert.equal(options.headers['Content-Type'], undefined);
    return response;
  } });
  await account.refresh();
  const failed = account.logout();
  assert.equal(await account.logout(), null);
  await assert.rejects(failed);
  assert.equal(calls, 1);
  assert.equal(account.getState().phase, 'error');
  await account.refresh();
  response = new Response(null, { status: 204 });
  await account.logout();
  assert.equal(account.getState().phase, 'guest');
  assert.equal(account.getState().user, null);
});

test('a rejected logout exposes its error and requires me before another mutation', async () => {
  for (const status of [400, 401, 403, 409, 413, 415, 429]) {
    let posts = 0;
    const account = createAccountState({ fetchImpl: async url => {
      if (url.endsWith('/me')) return json({ user });
      posts++;
      return failure(status, status === 403 ? 'ORIGIN_REJECTED' : 'API_ERROR');
    } });
    await account.refresh();
    await assert.rejects(account.logout(), error => error.status === status && !error.uncertain);
    assert.equal(account.getState().phase, 'error');
    assert.equal(account.getState().error, 'Запрос не выполнен.');
    assert.equal(account.canUsePersonalActions(), false);
    assert.equal(await account.logout(), null);
    assert.equal(posts, 1);
    await account.refresh();
    assert.equal(account.getState().phase, 'authenticated');
    assert.deepEqual(account.getState().user, user);
    assert.equal(account.getState().error, null);
  }
});

test('timeout aborts the actual request and leaves an explicit recoverable error', async () => {
  const account = createAccountState({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  await assert.rejects(account.refresh(), /вовремя/);
  assert.equal(account.getState().phase, 'error');
});

test('malformed profiles, JSON, unexpected success statuses and me errors cannot authenticate or invent a guest', async () => {
  for (const response of [json({ user: { ...user, id: 'fake' } }), json({}), new Response('not JSON'), failure(503, 'DATABASE_UNAVAILABLE')]) {
    const account = createAccountState({ fetchImpl: async () => response });
    await assert.rejects(account.refresh());
    assert.equal(account.getState().phase, 'error');
  }
  for (const response of [json({ user: null }), json({ user }, 201)]) {
    const account = createAccountState({ fetchImpl: async url => url.endsWith('/me') ? json({ user: null }) : response });
    await account.refresh();
    await assert.rejects(account.authenticate('login', { email: user.email, password: 'twelve chars' }));
    assert.equal(account.getState().phase, 'error');
  }
});

test('built Worker serves the exact account state module, with JS MIME and a closed source path', async () => {
  const worker = (await import('../dist/server/index.js')).default;
  const response = await worker.fetch(new Request('https://test/account-state.js'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), await readFile(new URL('../src/account-state.js', import.meta.url), 'utf8'));
  assert.equal((await worker.fetch(new Request('https://test/src/account-state.js'))).status, 404);
});
