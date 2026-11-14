import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import worker from '../../dist/server/index.js';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService } from '../../src/backend/sessions.mjs';
import { createAuthenticationGuard } from '../../src/backend/authentication.mjs';
import { createNodeApiHandler } from '../../src/backend/router.mjs';
import { createRequestHandler } from '../../src/backend/http-adapter.mjs';
import { IMAGE_LIMITS } from '../../src/backend/image-metadata.mjs';
import { images, animatedPng, animatedWebp, multipart, multipartType, metadata } from '../fixtures/image-files.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const authConfig = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test' });
async function isolated(work) {
  const database = createDatabase(), schema = 'p18_test_' + randomUUID().replaceAll('-', '');
  let pool, server;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schema},pg_catalog` }); pool.on('error', () => {});
    await applyMigrations(pool);
    const { rows: [user] } = await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id',
      [randomUUID() + '@example.test', 'P18 HTTP fixture', 'P18_TEST_ONLY_NOT_A_LOGIN_HASH']);
    const sessions = createSessionService({ database: { pool }, config: authConfig });
    const issued = await sessions.issue(user.id), cookie = issued.cookie.split(';')[0];
    const seen = [], adapterErrors = [];
    // Test-only sinks prove validation occurs before a future P19/P21 handler.
    // They never write images, and are not installed by tools/serve.mjs.
    const handlers = Object.fromEntries(['images.create', 'images.update'].map(action => [action, context => {
      seen.push(context); return Response.json({ validated: true, action });
    }]));
    server = http.createServer(createRequestHandler({ worker, onError: () => adapterErrors.push('unexpected'),
      nodeApi: createNodeApiHandler({ database: { pool }, beforeHandle: createAuthenticationGuard({ sessions, config: authConfig }), handlers }) }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const headers = { Origin: authConfig.publicOrigin, Cookie: cookie };
    const send = (body, extra = {}) => fetch(url + '/api/images', { method: 'POST', headers: { ...headers, 'Content-Type': multipartType, ...extra }, body, signal: AbortSignal.timeout(10000) });
    await work({ pool, url, user, headers, send, handlers, seen });
    assert.deepEqual(adapterErrors, []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 0);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await database.close();
  }
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.json(); assert.equal(body.error.code, code);
  assert.doesNotMatch(JSON.stringify(body), /SECRET|libpng|libvips|postgresql|password|fileData/);
}
async function headersOnly(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url + '/api/images', { method: 'POST', headers }, response => {
      const parts = []; response.on('data', data => parts.push(data));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(parts)) }));
      response.on('error', reject);
    });
    request.on('error', reject); request.flushHeaders();
  });
}

test('P18 HTTP validates real PNG/JPEG/WebP and passes exact bytes, dimensions and trusted session to the sink', async () => {
  await isolated(async ({ send, seen, user }) => {
    for (const [format, bytes] of Object.entries(images)) {
      const response = await send(multipart({ bytes, name: 'actual-content.exe', mimeType: `image/${format}` }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const context = seen.at(-1);
      assert.equal(context.auth.user.id, user.id);
      assert.deepEqual(context.body, { name: 'actual-content.exe', mimeType: `image/${format}`, fileData: bytes,
        width: 3, height: 2, bounds: metadata.bounds, angle: 0, opacity: .65, locked: false });
    }
    assert.equal(seen.length, 3);
  });
});

test('P18 HTTP rejects fake MIME, corrupt/animated files and invalid/forged metadata before the sink', async () => {
  await isolated(async ({ send, seen }) => {
    for (const [options, status, code] of [
      [{ bytes: images.jpeg }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ bytes: Buffer.from('<svg>SECRET</svg>') }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ bytes: Buffer.from('<html>SECRET</html>') }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ bytes: images.png.subarray(0, -1) }, 400, 'INVALID_IMAGE'],
      [{ bytes: animatedPng }, 400, 'INVALID_IMAGE'],
      [{ bytes: animatedWebp, mimeType: 'image/webp' }, 400, 'INVALID_IMAGE'],
      [{ fields: { ...metadata, user_id: 'forged' } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { bounds: [[0, 170], [1, -170]] } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, angle: 181 } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, opacity: '0.5' } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, locked: 0 } }, 400, 'VALIDATION_ERROR'],
      [{ name: '../SECRET.png' }, 400, 'VALIDATION_ERROR'],
    ]) await error(await send(multipart(options)), status, code);
    assert.equal(seen.length, 0);
  });
});

test('P18 HTTP method/Origin/session/501 and advertised body limits return JSON before upload bytes', async () => {
  await isolated(async ({ url, headers, handlers, seen }) => {
    const input = { ...headers, 'Content-Type': multipartType, 'Content-Length': String(IMAGE_LIMITS.bodyBytes + 1) };
    for (const [overrides, expected, code] of [[{ Cookie: '' }, 401, 'AUTH_REQUIRED'],
      [{ Origin: 'https://evil.example.test' }, 403, 'ORIGIN_REJECTED'], [{}, 413, 'PAYLOAD_TOO_LARGE']]) {
      const response = await headersOnly(url, { ...input, ...overrides });
      assert.equal(response.status, expected); assert.equal(response.body.error.code, code);
      assert.equal(response.headers.connection, 'close'); assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    delete handlers['images.create'];
    const unfinished = await headersOnly(url, input);
    assert.equal(unfinished.status, 501); assert.equal(unfinished.body.error.code, 'NOT_IMPLEMENTED');
    assert.equal(seen.length, 0);
  });
});

test('P18 HTTP patch validation is strict and preserves inclusive 8 KiB limits and omitted values', async () => {
  await isolated(async ({ url, headers, seen }) => {
    const patch = body => fetch(url + '/api/images/' + randomUUID(), { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(10000) });
    const valid = JSON.stringify({ revision: 1, opacity: 0, locked: false });
    const exact = valid + ' '.repeat(8192 - Buffer.byteLength(valid));
    assert.equal((await patch(exact)).status, 200);
    assert.deepEqual(seen[0].body, { revision: 1, opacity: 0, locked: false });
    await error(await patch(exact + ' '), 413, 'PAYLOAD_TOO_LARGE');
    for (const value of [{ revision: 1 }, { revision: 1, userId: 'forged', opacity: 0 }, { revision: 1, angle: 180.5 },
      { revision: 1, bounds: [[0, 0], [Infinity, 1]] }, { revision: 0, locked: true }]) {
      await error(await patch(JSON.stringify(value)), 400, 'VALIDATION_ERROR');
    }
    assert.equal(seen.length, 1);
  });
});
