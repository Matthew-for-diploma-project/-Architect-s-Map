import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createAuthenticationGuard } from '../src/backend/authentication.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';
import { createRequestHandler } from '../src/backend/http-adapter.mjs';
import { ApiError } from '../src/backend/http-errors.mjs';

const config = { publicOrigin: 'https://map.example.test' };
function request(method, url, headers = {}, chunks = ['unread']) {
  return Object.assign(Readable.from(chunks), { method, url, headers });
}
function router(sessions, handlers) {
  return createNodeApiHandler({ beforeHandle: createAuthenticationGuard({ sessions, config }), handlers });
}

test('every mutating contract rejects foreign/missing/null Origin before lookup or body', async () => {
  const handle = router({ resolve() { throw new Error('Must not look up a session'); } });
  for (const [method, path] of [['POST', '/api/auth/register'], ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'],
    ['POST', '/api/images'], ['PATCH', '/api/images/id'], ['DELETE', '/api/images/id'], ['PATCH', '/api/layer-settings']]) {
    for (const origin of [undefined, 'null', 'http://localhost', 'https://map.example.test.evil', config.publicOrigin + '/', 'https://evil.test']) {
      const incoming = request(method, path, { ...(origin ? { origin } : {}), host: 'map.example.test', 'x-forwarded-host': 'map.example.test', 'x-forwarded-proto': 'https' });
      const response = await handle(incoming);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
      assert.equal(incoming.readableFlowing, null);
    }
  }
});

test('private APIs require an authenticated identity before body or dynamic ID decoding', async () => {
  const handle = router({ resolve: async () => null });
  for (const [method, path] of [['GET', '/api/images'], ['POST', '/api/images'], ['GET', '/api/images/id/file'],
    ['GET', '/api/images/%ZZ/file'], ['PATCH', '/api/images/id'], ['DELETE', '/api/images/id'], ['GET', '/api/layer-settings'], ['PATCH', '/api/layer-settings']]) {
    const incoming = request(method, path, { origin: config.publicOrigin, 'content-length': '999999999', 'x-user-id': 'forged-user' });
    const response = await handle(incoming);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');
    assert.equal(incoming.readableFlowing, null);
  }
});

test('a private handler cannot run when an entry point omits or misconfigures its guard', async () => {
  let called = false;
  for (const beforeHandle of [undefined, () => null, () => ({}), () => ({ user: { id: '' } })]) {
    const handle = createNodeApiHandler({ beforeHandle, handlers: { 'images.list': () => { called = true; return Response.json({ secret: 'never return' }); } } });
    const incoming = request('GET', '/api/images');
    assert.equal((await handle(incoming)).status, 401);
    assert.equal(incoming.readableFlowing, null);
  }
  assert.equal(called, false);
});

test('known paths check methods first; legacy and unknown routes do not resolve sessions', async () => {
  const handle = router({ resolve() { throw new Error('Unexpected lookup'); } });
  assert.equal(await handle(request('POST', '/api/objects')), null);
  assert.equal(await handle(request('GET', '/')), null);
  assert.equal((await handle(request('POST', '/api/auth/missing'))).status, 404);
  const response = await handle(request('PUT', '/api/images'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('authenticated handlers receive only the verified identity, independent of Host and submitted owner', async () => {
  const auth = { user: { id: 'verified-user', email: 'a@example.test', name: 'А' }, session: { id: 'server-session' } };
  const handle = router({ resolve: async () => auth }, { 'layerSettings.update': context => Response.json({ owner: context.auth.user.id }) });
  const response = await handle(request('PATCH', '/api/layer-settings', {
    origin: config.publicOrigin, host: 'untrusted.test', 'x-forwarded-host': 'evil.test', 'content-type': 'application/json',
  }, ['{"userId":"another-user"}']));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { owner: 'verified-user' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('optional public sessions preserve guest 501 and propagate a database outage instead of a fake guest', async () => {
  const guest = router({ resolve: async () => null });
  assert.equal((await guest(request('GET', '/api/auth/me', {}, []))).status, 501);
  const unavailable = router({ resolve() { throw new ApiError('DATABASE_UNAVAILABLE'); } });
  const response = await unavailable(request('GET', '/api/auth/me', {}, []));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
});

test('real HTTP rejects unfinished unauthorized uploads with JSON before consuming their body', async t => {
  const handle = router({ resolve: async () => null });
  const server = http.createServer(createRequestHandler({ worker: { fetch() { throw new Error('Worker must not receive private requests'); } }, nodeApi: handle }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  for (const origin of ['https://evil.test', config.publicOrigin]) {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/images', method: 'POST', headers: {
        Origin: origin, 'Content-Length': '999999999', 'Content-Type': 'multipart/form-data; boundary=example',
      } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body }); req.destroy(); });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('HTTP auth test timed out')));
      req.write('not a complete upload');
    });
    assert.equal(response.status, origin === config.publicOrigin ? 401 : 403);
    assert.equal(JSON.parse(response.body).error.code, origin === config.publicOrigin ? 'AUTH_REQUIRED' : 'ORIGIN_REJECTED');
    assert.equal(response.headers.connection, 'close');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});
