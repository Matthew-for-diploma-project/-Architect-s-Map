import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import worker from '../dist/server/index.js';
import { createRequestHandler } from '../src/backend/http-adapter.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';

async function serve(t, options = {}) {
  const server = http.createServer(createRequestHandler({ worker, nodeApi: createNodeApiHandler(), ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

function send(port, { path, method = 'GET', headers = {}, chunks = [], end = true, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, res => {
      const received = [];
      res.on('data', chunk => received.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(received), reused: req.reusedSocket });
        if (!end) req.destroy();
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test timed out')));
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
    else req.flushHeaders();
  });
}

test('HTTP adapter routes new namespaces first and preserves Worker resources and legacy API errors', async t => {
  const port = await serve(t);
  for (const [path, file] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/geo.js', 'geo.mjs'], ['/genplan-calibration.js', 'genplan-calibration.mjs'], ['/genplan.jpg', 'genplan.jpg']]) {
    const response = await send(port, { path });
    assert.equal(response.status, 200);
    assert.deepEqual(response.bytes, readFileSync(new URL('../src/' + file, import.meta.url)));
  }
  for (const path of ['/.env', '/.env.test', '/src/backend/router.mjs', '/compose.yaml']) {
    const response = await send(port, { path });
    assert.equal(response.status, 404);
    assert.equal(response.bytes.toString(), 'Not found');
  }
  const unknownOld = await send(port, { path: '/api/unknown' });
  assert.equal(unknownOld.status, 404);
  assert.deepEqual(JSON.parse(unknownOld.bytes), { error: 'Маршрут не найден' });
  const wrongOld = await send(port, { path: '/api/objects', method: 'POST', chunks: ['old body'] });
  assert.equal(wrongOld.status, 405);
  assert.deepEqual(JSON.parse(wrongOld.bytes), { error: 'Только GET' });
  const newApi = await send(port, { path: '/api/images' });
  assert.equal(newApi.status, 401);
  assert.equal(JSON.parse(newApi.bytes).error.code, 'AUTH_REQUIRED');
  assert.equal(newApi.headers['cache-control'], 'private, no-store');
  const unknownNew = await send(port, { path: '/api/auth/missing' });
  assert.equal(unknownNew.status, 404);
  assert.equal(JSON.parse(unknownNew.bytes).error.code, 'NOT_FOUND');
});

test('HTTP 405 includes Allow; HEAD writes no body and does not execute a GET handler', async t => {
  let calls = 0;
  const port = await serve(t, { nodeApi: createNodeApiHandler({ handlers: {
    'auth.me': () => { calls++; return Response.json({ user: null }); },
  } }) });
  const response = await send(port, { path: '/api/auth/me', method: 'HEAD' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.bytes.length, 0);
  assert.equal(calls, 0);
});

test('advertised and chunked oversized uploads receive JSON 413 without finishing the upload', async t => {
  const port = await serve(t);
  for (const headers of [
    { 'content-type': 'application/json', 'content-length': '999999999' },
    { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  ]) {
    const response = await send(port, { path: '/api/auth/register', method: 'POST', headers, chunks: [Buffer.alloc(16385, 0x20)], end: false });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.bytes).error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(response.headers.connection, 'close');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});

test('Node bridge preserves an untouched legacy request body, fixed routing origin and headers', async t => {
  const port = await serve(t, { worker: { async fetch(request) {
    assert.equal(new URL(request.url).origin, 'http://localhost');
    assert.equal(request.headers.get('x-example'), 'original');
    return new Response(await request.arrayBuffer(), { headers: { 'Content-Type': 'application/octet-stream' } });
  } } });
  const body = Buffer.from('legacy POST bytes \u0000 конец');
  const response = await send(port, { path: '/api/objects', method: 'POST', headers: { Host: 'untrusted.example', 'X-Example': 'original' }, chunks: [body] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, body);
  assert.equal(response.headers['cache-control'], undefined);
});

test('private response policy preserves separate Set-Cookie values and normal keep-alive', async t => {
  const port = await serve(t, { nodeApi: createNodeApiHandler({ handlers: { 'auth.me': () => {
    const headers = new Headers({ 'Cache-Control': 'public' });
    headers.append('Set-Cookie', 'session=first; HttpOnly; Path=/');
    headers.append('Set-Cookie', 'other=second; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/');
    return Response.json({ user: null }, { headers });
  } } }) });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const first = await send(port, { path: '/api/auth/me', agent });
  const second = await send(port, { path: '/api/auth/me', agent });
  assert.equal(second.reused, true);
  assert.equal(first.headers['cache-control'], 'private, no-store');
  assert.deepEqual(first.headers['set-cookie'], [
    'session=first; HttpOnly; Path=/', 'other=second; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
  ]);
});

test('client abort reaches the Node API signal while its body is being read', async t => {
  let observe;
  const ready = new Promise(resolve => { observe = resolve; });
  const port = await serve(t, { nodeApi: createNodeApiHandler({ beforeHandle(context) { observe(context.signal); } }) });
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.write('{');
  const signal = await ready;
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  req.destroy();
  await aborted;
  assert.equal(signal.aborted, true);
});

test('bridge failures use safe API JSON or the original Worker error format without logging details', async t => {
  let errors = 0;
  const port = await serve(t, {
    nodeApi: incoming => incoming.url.startsWith('/api/auth') ? Promise.reject(new Error('NODE_TOP_SECRET')) : null,
    worker: { fetch() { throw new Error('WORKER_TOP_SECRET'); } },
    onError() { assert.equal(arguments.length, 0); errors++; },
  });
  const api = await send(port, { path: '/api/auth/me' });
  assert.equal(api.status, 500);
  assert.equal(JSON.parse(api.bytes).error.code, 'INTERNAL_ERROR');
  assert.equal(api.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(api.bytes.toString(), /TOP_SECRET/);
  const old = await send(port, { path: '/' });
  assert.equal(old.status, 500);
  assert.deepEqual(JSON.parse(old.bytes), { error: 'Ошибка локального HTTP-адаптера' });
  assert.equal(errors, 2);
});
