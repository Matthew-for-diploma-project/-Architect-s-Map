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
      await pool.query('INSERT INTO layer_settings(user_id) VALUES($1)', [user.id]);
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
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Early response timed out'))); request.flushHeaders();
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

test('P19 an actual AFTER INSERT database failure rolls back bytes and metadata and returns safe 503', async () => {
  await isolated(async ({ pool, post, a, count, writes, releases }) => {
    await pool.query("CREATE FUNCTION p19_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P19_SQL_SECRET'; END; $$");
    await pool.query('CREATE TRIGGER p19_fail AFTER INSERT ON images FOR EACH ROW EXECUTE FUNCTION p19_fail()');
    await error(await post(a), 503, 'DATABASE_UNAVAILABLE');
    assert.equal(await count(), 0);
    assert.equal(writes.filter(sql => sql.includes('INSERT INTO images')).length, 1);
    assert.equal(writes.at(-1), 'ROLLBACK'); assert.ok(!writes.includes('COMMIT'));
    assert.deepEqual(releases, [false]);
  });
});

test('P19 failed files do not undo earlier uploads or alter another account or its layer settings', async () => {
  await isolated(async ({ pool, post, a, b, count }) => {
    const settings = (await pool.query('SELECT * FROM layer_settings ORDER BY user_id')).rows;
    await pool.query("CREATE FUNCTION p19_reject_name() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='reject.png' THEN RAISE EXCEPTION 'P19_SQL_SECRET'; END IF; RETURN NEW; END; $$");
    await pool.query('CREATE TRIGGER p19_reject_name AFTER INSERT ON images FOR EACH ROW EXECUTE FUNCTION p19_reject_name()');
    const first = await post(a, { name: 'same.png' }); assert.equal(first.status, 201);
    const one = (await first.json()).image;
    await error(await post(a, { bytes: images.jpeg }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await error(await post(a, { name: 'reject.png' }), 503, 'DATABASE_UNAVAILABLE');
    assert.equal(await count(), 1);
    const second = await post(b, { name: 'same.png' }), third = await post(a, { name: 'same.png' });
    assert.equal(second.status, 201); assert.equal(third.status, 201);
    const two = (await second.json()).image, three = (await third.json()).image;
    assert.equal(new Set([one.id, two.id, three.id]).size, 3); assert.equal(await count(), 3);
    const rows = (await pool.query('SELECT id,user_id,file_data FROM images ORDER BY id')).rows;
    for (const row of rows) { assert.deepEqual(row.file_data, images.png); assert.equal(row.user_id, row.id === two.id ? b.user.id : a.user.id); }
    assert.deepEqual((await pool.query('SELECT * FROM layer_settings ORDER BY user_id')).rows, settings);
  });
});

test('P19 overlapping file requests use independent transactions and distinct server IDs', async () => {
  let signalEntered, release;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let inserts = 0;
  await isolated(async ({ post, a, b, pool, count }) => {
    let settled = false;
    const pending = Promise.all([post(a, { name: 'same.bin' }), post(b, { name: 'same.bin', bytes: images.jpeg, mimeType: 'image/jpeg' })])
      .then(responses => { settled = true; return responses; });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Both INSERT statements must complete before COMMIT')), 5000);
        entered.then(() => { clearTimeout(timer); resolve(); });
      });
      assert.equal(inserts, 2); assert.equal(settled, false);
      assert.equal(await count(), 0, 'uncommitted images are not visible on another connection');
    } finally { release(); }
    const responses = await pending; assert.ok(responses.every(response => response.status === 201));
    const [first, second] = await Promise.all(responses.map(response => response.json()));
    assert.notEqual(first.image.id, second.image.id); assert.equal(await count(), 2);
    for (const [account, image, bytes] of [[a, first.image, images.png], [b, second.image, images.jpeg]]) {
      const row = (await pool.query('SELECT user_id,file_data FROM images WHERE id=$1', [image.id])).rows[0];
      assert.equal(row.user_id, account.user.id); assert.deepEqual(row.file_data, bytes);
    }
  }, { queryHook: async (client, sql, values) => {
    const result = await client.query(sql, values);
    if (sql.includes('INSERT INTO images')) { if (++inserts === 2) signalEntered(); await gate; }
    return result;
  } });
});

test('P19 a post-INSERT response construction failure rolls back the real row', async () => {
  await isolated(async ({ post, a, count, writes, releases }) => {
    await error(await post(a), 500, 'INTERNAL_ERROR');
    assert.equal(await count(), 0); assert.equal(writes.at(-1), 'ROLLBACK');
    assert.ok(!writes.includes('COMMIT')); assert.deepEqual(releases, [false]);
  }, { queryHook: async (client, sql, values) => {
    const result = await client.query(sql, values);
    if (sql.includes('INSERT INTO images')) result.rows[0].angle = 1n; // Simulate serialization failure after a real INSERT.
    return result;
  } });
});

test('P19 losing COMMIT acknowledgement reports 503 without blindly inserting a second copy', async () => {
  await isolated(async ({ pool, post, a, count, writes, releases }) => {
    await error(await post(a, { name: 'uncertain.png' }), 503, 'DATABASE_UNAVAILABLE');
    // COMMIT really executed before the simulated lost reply. The outcome must
    // not be advertised as success or automatically retried as another POST.
    assert.equal(await count(), 1);
    const row = (await pool.query('SELECT user_id,name,file_data FROM images')).rows[0];
    assert.equal(row.user_id, a.user.id); assert.equal(row.name, 'uncertain.png'); assert.deepEqual(row.file_data, images.png);
    assert.equal(writes.filter(sql => sql.includes('INSERT INTO images')).length, 1);
    assert.equal(writes.filter(sql => sql === 'COMMIT').length, 1);
    assert.ok(!writes.includes('ROLLBACK')); assert.deepEqual(releases, [true]);
  }, { queryHook: async (client, sql, values) => {
    const result = await client.query(sql, values);
    if (sql === 'COMMIT') throw new Error('P19_COMMIT_REPLY_SECRET');
    return result;
  } });
});
