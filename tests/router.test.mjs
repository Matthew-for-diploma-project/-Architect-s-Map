import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createNodeApiHandler } from '../src/backend/router.mjs';
import { ApiError, apiErrorResponse } from '../src/backend/http-errors.mjs';
import { readBoundedBody } from '../src/backend/request-body.mjs';
import { images, metadata, multipart, multipartType } from './fixtures/image-files.mjs';

function request(method, url, chunks = [], headers = {}) {
  const incoming = Readable.from(chunks, { objectMode: false });
  Object.assign(incoming, { method, url, headers });
  return incoming;
}
async function errorCode(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const value = await response.json();
  assert.equal(value.error.code, code);
  assert.equal(typeof value.error.message, 'string');
  return value;
}
const jsonHeaders = { 'content-type': 'application/json' };
const testIdentity = () => ({ user: { id: 'verified-test-user' } });

test('all eleven method/path contracts reach their handler with private response headers', async () => {
  const cases = [
    ['POST', '/api/auth/register', 'auth.register', '{}', jsonHeaders],
    ['POST', '/api/auth/login', 'auth.login', '{}', jsonHeaders],
    ['GET', '/api/auth/me', 'auth.me'], ['POST', '/api/auth/logout', 'auth.logout'],
    ['GET', '/api/images', 'images.list'],
    ['POST', '/api/images', 'images.create', multipart(), { 'content-type': multipartType }],
    ['GET', '/api/images/123/file', 'images.file'],
    ['PATCH', '/api/images/123', 'images.update', '{"revision":1,"opacity":0.5}', jsonHeaders],
    ['DELETE', '/api/images/123', 'images.delete'],
    ['GET', '/api/layer-settings', 'layerSettings.get'],
    ['PATCH', '/api/layer-settings', 'layerSettings.update', '{}', jsonHeaders],
  ];
  const database = { pool: 'server-only context' };
  const signal = new AbortController().signal;
  for (const [method, path, action, body, headers = {}] of cases) {
    let calls = 0;
    const handle = createNodeApiHandler({ database, beforeHandle: testIdentity, handlers: { [action]: context => {
      calls++;
      assert.equal(context.action, action);
      assert.equal(context.method, method);
      assert.equal(context.database, database);
      assert.equal(context.signal, signal);
      assert.equal(context.headers.get('x-test'), 'present');
      if (path.includes('123')) assert.equal(context.params.id, '123');
      if (headers === jsonHeaders) assert.deepEqual(context.body, action === 'images.update' ? { revision: 1, opacity: .5 } : {});
      if (action === 'images.create') {
        assert.deepEqual(context.body.fileData, images.png); assert.deepEqual(context.body.bounds, metadata.bounds);
        assert.deepEqual([context.body.width, context.body.height], [3, 2]);
      }
      return Response.json({ action }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    } } });
    const response = await handle(request(method, path + '?limit=10', body ? [body] : [], { ...headers, 'x-test': 'present' }), { signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { action });
    assert.equal(calls, 1);
  }
});

test('only exact API namespaces are owned; Worker requests and their streams stay untouched', async () => {
  const handle = createNodeApiHandler();
  for (const path of ['/', '/app.js', '/genplan.jpg', '/api/objects', '/api/cadastre/search', '/api/authentic', '/api/images-old', '/api/layer-settings2']) {
    const incoming = request('POST', path, ['original body']);
    assert.equal(await handle(incoming), null);
    assert.equal(incoming.readableFlowing, null);
    assert.equal(await readBoundedBody(incoming, 100).then(value => value.toString()), 'original body');
  }
  for (const path of ['/api/auth', '/api/auth/missing', '/api/auth/me/', '/api/images/', '/api/images/id/extra', '/api/layer-settings/extra']) {
    await errorCode(await handle(request('GET', path)), 404, 'NOT_FOUND');
  }
});

test('wrong methods return 405 and an exact Allow list before guards or body reads', async () => {
  let guardCalls = 0;
  const handle = createNodeApiHandler({ beforeHandle() { guardCalls++; } });
  const cases = [
    ['/api/auth/register', 'POST'], ['/api/auth/login', 'POST'], ['/api/auth/me', 'GET'],
    ['/api/auth/logout', 'POST'], ['/api/images', 'GET, POST'],
    ['/api/images/id/file', 'GET'], ['/api/images/id', 'PATCH, DELETE'],
    ['/api/layer-settings', 'GET, PATCH'],
  ];
  for (const [path, allow] of cases) {
    for (const method of ['PUT', 'OPTIONS', 'HEAD', 'toString']) {
      const incoming = request(method, path, ['unread']);
      const response = await handle(incoming);
      await errorCode(response, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(response.headers.get('allow'), allow);
      assert.equal(incoming.readableFlowing, null);
    }
  }
  assert.equal(guardCalls, 0);
});

test('unfinished public operations return 501 and private guests fail before uploads', async () => {
  const handle = createNodeApiHandler();
  for (const [method, path, chunks, headers] of [
    ['POST', '/api/auth/login', ['{}'], jsonHeaders],
    ['POST', '/api/auth/register', ['{}'], jsonHeaders],
    ['GET', '/api/auth/me', []], ['POST', '/api/auth/logout', []],
  ]) await errorCode(await handle(request(method, path, chunks, headers)), 501, 'NOT_IMPLEMENTED');
  for (const [method, path] of [['POST', '/api/images'], ['PATCH', '/api/images/id'], ['GET', '/api/layer-settings']]) {
    const incoming = request(method, path, ['must not read'], { 'content-length': '999999999' });
    await errorCode(await handle(incoming), 401, 'AUTH_REQUIRED');
    assert.equal(incoming.readableFlowing, null);
  }
});

test('Origin/session hook rejects before body/media parsing and passes auth state to handlers', async () => {
  let called = false;
  const handle = createNodeApiHandler({
    beforeHandle(context) { assert.equal(context.isPrivate, true); throw new ApiError('AUTH_REQUIRED'); },
    handlers: { 'images.create'() { called = true; return new Response(); } },
  });
  const incoming = request('POST', '/api/images', ['unread'], { 'content-length': '999999999' });
  await errorCode(await handle(incoming), 401, 'AUTH_REQUIRED');
  assert.equal(incoming.readableFlowing, null);
  assert.equal(called, false);
  const allowed = createNodeApiHandler({
    beforeHandle() { return { user: { id: 'verified' } }; },
    handlers: { 'images.list': context => Response.json({ owner: context.auth.user.id }) },
  });
  assert.deepEqual(await (await allowed(request('GET', '/api/images'))).json(), { owner: 'verified' });
});

test('JSON parsing rejects wrong media, encoding, syntax, UTF-8 and non-object roots safely', async () => {
  const handle = createNodeApiHandler();
  for (const [body, headers, status, code] of [
    ['{}', {}, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['{}', { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['{}', { 'content-type': 'application/json; charset=latin1' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['{}', { ...jsonHeaders, 'content-encoding': 'gzip' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ...['', '{TOP_SECRET', 'null', '[]', '123', '"text"'].map(body => [body, jsonHeaders, 400, 'VALIDATION_ERROR']),
    [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), jsonHeaders, 400, 'VALIDATION_ERROR'],
  ]) {
    const response = await handle(request('POST', '/api/auth/login', [body], headers));
    assert.doesNotMatch(JSON.stringify(await errorCode(response, status, code)), /TOP_SECRET/);
  }
  await errorCode(await handle(request('POST', '/api/auth/login', ['{}'], { 'content-type': 'Application/JSON; charset="UTF-8"' })), 501, 'NOT_IMPLEMENTED');
});

test('account JSON limit is inclusive and counts UTF-8 bytes with or without Content-Length', async () => {
  const handle = createNodeApiHandler();
  const exact = '{"x":"' + 'я'.repeat((16384 - 8) / 2) + '"}';
  assert.equal(Buffer.byteLength(exact), 16384);
  for (const headers of [jsonHeaders, { ...jsonHeaders, 'content-length': '16384' }]) {
    await errorCode(await handle(request('POST', '/api/auth/login', [exact], headers)), 501, 'NOT_IMPLEMENTED');
  }
  for (const chunks of [[exact, ' '], [Buffer.alloc(20000)]]) {
    await errorCode(await handle(request('POST', '/api/auth/login', chunks, jsonHeaders)), 413, 'PAYLOAD_TOO_LARGE');
  }
  const advertised = request('POST', '/api/auth/register', ['unread'], { ...jsonHeaders, 'content-length': '16385' });
  await errorCode(await handle(advertised), 413, 'PAYLOAD_TOO_LARGE');
  assert.equal(advertised.readableFlowing, null);
});

test('PATCH limits are 8 KiB and validated multipart total limit is 21 MiB before the handler', async () => {
  let calls = 0;
  const accept = () => { calls++; return new Response(null, { status: 204 }); };
  const handle = createNodeApiHandler({ beforeHandle: testIdentity, handlers: {
    'images.update': accept, 'layerSettings.update': accept, 'images.create': accept,
  } });
  const exactJson = '{"x":"' + 'a'.repeat(8192 - 8) + '"}';
  for (const path of ['/api/images/id', '/api/layer-settings']) {
    const json = path.startsWith('/api/images/') ? '{"revision":1,"opacity":0.5}' : exactJson;
    const padded = json + ' '.repeat(8192 - Buffer.byteLength(json));
    assert.equal((await handle(request('PATCH', path, [padded], jsonHeaders))).status, 204);
    await errorCode(await handle(request('PATCH', path, [padded, ' '], jsonHeaders)), 413, 'PAYLOAD_TOO_LARGE');
  }
  const headers = { 'content-type': multipartType };
  const body = multipart(), preamble = Buffer.alloc(21 * 1024 * 1024 - body.length, 'a'); preamble.write('\r\n', preamble.length - 2);
  assert.equal((await handle(request('POST', '/api/images', [preamble, body], headers))).status, 204);
  await errorCode(await handle(request('POST', '/api/images', [preamble, body, Buffer.from('x')], headers)), 413, 'PAYLOAD_TOO_LARGE');
  await errorCode(await handle(request('POST', '/api/images', ['{}'], jsonHeaders)), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(calls, 3);
});

test('zero-body contracts reject actual bytes and forged lengths do not bypass counting', async () => {
  const accept = () => new Response(null, { status: 204 });
  const handle = createNodeApiHandler({ beforeHandle: testIdentity, handlers: { 'images.list': accept, 'images.delete': accept } });
  for (const [method, path] of [['GET', '/api/images'], ['DELETE', '/api/images/id'], ['POST', '/api/auth/logout']]) {
    await errorCode(await handle(request(method, path, ['x'])), 413, 'PAYLOAD_TOO_LARGE');
  }
  await assert.rejects(readBoundedBody(request('POST', '/', ['abcdef'], { 'content-length': '1' }), 5), { code: 'PAYLOAD_TOO_LARGE' });
  await assert.rejects(readBoundedBody(request('POST', '/', ['abc'], { 'content-length': '1' }), 5), { code: 'VALIDATION_ERROR' });
  for (const length of ['-1', ' 1', '1.1', 'bad']) {
    await assert.rejects(readBoundedBody(request('POST', '/', [], { 'content-length': length }), 5), { code: 'VALIDATION_ERROR' });
  }
});

test('oversized or failed streams stop reading without destroying the socket for the JSON error', async () => {
  const incoming = request('POST', '/', [Buffer.alloc(9)]);
  await assert.rejects(readBoundedBody(incoming, 8), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(incoming.destroyed, false);
  const broken = new Readable({ read() { this.destroy(new Error('password=TOP_SECRET')); } });
  broken.headers = {};
  await assert.rejects(readBoundedBody(broken, 8), error => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.doesNotMatch(error.stack, /TOP_SECRET/);
    return true;
  });
});

test('public errors use the common contract; unexpected handler failures never echo secrets', async () => {
  const secret = 'SELECT password_hash TOP_SECRET postgresql://user:password@db';
  for (const handler of [() => { throw new Error(secret); }, () => ({ error: secret })]) {
    const handle = createNodeApiHandler({ handlers: { 'auth.me': handler } });
    const value = await errorCode(await handle(request('GET', '/api/auth/me')), 500, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(value), /TOP_SECRET|SELECT|postgresql|password_hash|stack/);
  }
  const fields = { email: 'Некорректная почта.' };
  assert.deepEqual((await errorCode(apiErrorResponse(new ApiError('VALIDATION_ERROR', { fields })), 400, 'VALIDATION_ERROR')).error.fields, fields);
  const rate = apiErrorResponse(new ApiError('RATE_LIMITED', { headers: { 'Retry-After': '30' } }));
  assert.equal(rate.headers.get('retry-after'), '30');
  await errorCode(rate, 429, 'RATE_LIMITED');
  await errorCode(apiErrorResponse(new ApiError('DATABASE_UNAVAILABLE')), 503, 'DATABASE_UNAVAILABLE');
  await errorCode(apiErrorResponse({ code: 'DATABASE_UNAVAILABLE', message: secret, fields: { password: secret } }), 500, 'INTERNAL_ERROR');
});

test('dynamic path decoding is bounded by a path segment and rejects malformed escapes', async () => {
  const handle = createNodeApiHandler({ beforeHandle: testIdentity, handlers: { 'images.file': context => Response.json({ id: context.params.id }) } });
  assert.deepEqual(await (await handle(request('GET', '/api/images/%31%32%33/file'))).json(), { id: '123' });
  for (const path of ['/api/images/%ZZ/file', '/api/images/a%2Fb/file']) {
    await errorCode(await handle(request('GET', path)), 400, 'VALIDATION_ERROR');
  }
});
