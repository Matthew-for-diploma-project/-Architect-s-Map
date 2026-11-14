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
import { createImageUploadHandler } from '../../src/backend/image-upload.mjs';
import { IMAGE_LIMITS } from '../../src/backend/image-metadata.mjs';
import { images, animatedPng, animatedWebp, multipart, multipartType, metadata, boundary } from '../fixtures/image-files.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const databaseConfig = readDatabaseConfig();
const authConfig = readAuthConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://map.example.test' });
async function isolated(work, { queryHook } = {}) {
  const database = createDatabase(), schema = 'p19_test_' + randomUUID().replaceAll('-', '');
  let pool, server;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...databaseConfig, max: 4, options: `-c search_path=${schema},pg_catalog` }); pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config: authConfig });
    const accounts = [];
    for (const name of ['A', 'B']) {
      const { rows: [user] } = await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id',
        [randomUUID() + '@example.test', name, 'P19_TEST_ONLY_NOT_A_LOGIN_HASH']);
      const session = await sessions.issue(user.id); accounts.push({ user, session, cookie: session.cookie.split(';')[0] });
    }
    const writes = [], releases = [], adapterErrors = [];
    let connections = 0;
    const uploadingDatabase = { pool: { async connect() {
      connections++;
      const client = await pool.connect();
      return { query(sql, values) { writes.push(sql); return queryHook ? queryHook(client, sql, values) : client.query(sql, values); },
        on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release(destroy) { releases.push(destroy); client.release(destroy); } };
    } } };
    server = http.createServer(createRequestHandler({ worker, onError: () => adapterErrors.push('unexpected'),
      nodeApi: createNodeApiHandler({ database: { pool }, beforeHandle: createAuthenticationGuard({ sessions, config: authConfig }),
        handlers: { 'images.create': createImageUploadHandler({ database: uploadingDatabase }) } }) }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const postRaw = (account, body, extra = {}) => fetch(url + '/api/images', { method: 'POST',
      headers: { Origin: authConfig.publicOrigin, ...(account ? { Cookie: account.cookie } : {}), 'Content-Type': multipartType, ...extra },
      body, signal: AbortSignal.timeout(10000) });
    const post = (account, options = {}, extra = {}) => postRaw(account, multipart(options), extra);
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n;
    await work({ pool, url, schema, post, postRaw, a: accounts[0], b: accounts[1], sessions, count, writes, releases, connections: () => connections });
    assert.deepEqual(adapterErrors, []);
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
  assert.equal(response.headers.get('set-cookie'), null);
  const value = await response.json(); assert.equal(value.error.code, code);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|postgresql|fileData|file_data|password|bytea/);
}
async function headersOnly(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url + '/api/images', { method: 'POST', headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks)) }));
      response.on('error', reject);
    });
    request.on('error', reject); request.flushHeaders();
  });
}

test('P19 HTTP persists exact PNG/JPEG/WebP bytes and metadata under the session owner with safe 201', async () => {
  await isolated(async ({ pool, post, a, b, count, connections }) => {
    for (const account of [a, b]) for (const [format, bytes] of Object.entries(images)) {
      const fields = account === a ? metadata : { ...metadata, angle: 37, opacity: .333, locked: true };
      const response = await post(account, { bytes, mimeType: `image/${format}`, fields });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('set-cookie'), null);
      const value = await response.json(); assert.deepEqual(Object.keys(value), ['image']);
      const image = value.image;
      assert.deepEqual(Object.keys(image).sort(), ['id', 'name', 'mimeType', 'sizeBytes', 'width', 'height', 'bounds', 'angle', 'opacity', 'locked', 'revision', 'createdAt', 'updatedAt', 'fileUrl'].sort());
      assert.match(image.id, /^[0-9a-f-]{36}$/); assert.equal(image.fileUrl, `/api/images/${image.id}/file`);
      assert.equal(image.mimeType, `image/${format}`); assert.equal(image.sizeBytes, bytes.length);
      assert.deepEqual([image.width, image.height, image.bounds], [3, 2, metadata.bounds]);
      assert.deepEqual([image.angle, image.opacity, image.locked, image.revision], account === a ? [0, .65, false, 1] : [37, .333, true, 1]);
      const { rows: [row] } = await pool.query('SELECT * FROM images WHERE id=$1', [image.id]);
      assert.equal(row.user_id, account.user.id); assert.deepEqual(row.file_data, bytes);
      assert.equal(row.size_bytes, bytes.length); assert.equal(row.name, image.name);
      assert.equal(row.created_at.toISOString(), image.createdAt.slice(0, 23) + 'Z');
      assert.equal(row.updated_at.toISOString(), image.updatedAt.slice(0, 23) + 'Z');
      assert.deepEqual([row.angle, row.opacity, row.locked, row.revision], [image.angle, image.opacity, image.locked, 1]);
    }
    assert.equal(await count(), 6); assert.equal(connections(), 6);
    for (const account of [a, b]) assert.equal((await pool.query('SELECT count(*)::int AS n FROM images WHERE user_id=$1', [account.user.id])).rows[0].n, 3);
  });
});

test('P19 guests/revoked/expired sessions and foreign Origin fail before reading uploads or opening a write transaction', async () => {
  await isolated(async ({ pool, url, a, b, sessions, count, connections }) => {
    const headers = { Origin: authConfig.publicOrigin, Cookie: a.cookie, 'Content-Type': multipartType,
      'Content-Length': String(IMAGE_LIMITS.bodyBytes + 1) };
    for (const [overrides, status, code] of [[{ Cookie: '' }, 401, 'AUTH_REQUIRED'],
      [{ Origin: 'https://evil.example.test' }, 403, 'ORIGIN_REJECTED'], [{}, 413, 'PAYLOAD_TOO_LARGE']]) {
      const response = await headersOnly(url, { ...headers, ...overrides });
      assert.equal(response.status, status); assert.equal(response.body.error.code, code); assert.equal(response.headers.connection, 'close');
    }
    await sessions.revoke(a.session.id);
    const revoked = await headersOnly(url, headers); assert.equal(revoked.status, 401);
    await pool.query("UPDATE sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',expires_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=$1", [b.session.id]);
    const expired = await headersOnly(url, { ...headers, Cookie: b.cookie }); assert.equal(expired.status, 401);
    assert.equal(connections(), 0); assert.equal(await count(), 0);
  });
});

test('P19 invalid files/metadata, owner substitution and multipart violations create no image or write transaction', async () => {
  await isolated(async ({ post, postRaw, a, b, count, connections }) => {
    for (const [options, status, code] of [
      [{ bytes: images.jpeg }, 415, 'UNSUPPORTED_MEDIA_TYPE'], [{ bytes: Buffer.from('<svg>SECRET</svg>') }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ bytes: images.png.subarray(0, -1) }, 400, 'INVALID_IMAGE'], [{ bytes: animatedPng }, 400, 'INVALID_IMAGE'],
      [{ bytes: animatedWebp, mimeType: 'image/webp' }, 400, 'INVALID_IMAGE'],
      [{ fields: { ...metadata, userId: b.user.id } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, user_id: b.user.id } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, id: randomUUID() } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { ...metadata, width: 1, height: 1 } }, 400, 'VALIDATION_ERROR'],
      [{ fields: { bounds: [[1, 0], [0, 1]] } }, 400, 'VALIDATION_ERROR'],
      [{ bytes: Buffer.alloc(IMAGE_LIMITS.fileBytes + 1) }, 413, 'PAYLOAD_TOO_LARGE'],
    ]) await error(await post(a, options), status, code);
    const original = multipart(), closing = Buffer.from(`--${boundary}--\r\n`);
    for (const extra of [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.png"\r\nContent-Type: image/png\r\n\r\n`), images.png, Buffer.from('\r\n')])]) {
      await error(await postRaw(a, Buffer.concat([original.subarray(0, -closing.length), extra, closing])), 400, 'VALIDATION_ERROR');
    }
    assert.equal(await count(), 0); assert.equal(connections(), 0);
  });
});
