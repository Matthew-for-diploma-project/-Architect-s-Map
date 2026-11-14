import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createImageUploadHandler } from '../src/backend/image-upload.mjs';
import { images, metadata } from './fixtures/image-files.mjs';

const userId = '19a00000-0000-4000-8000-000000000001';
const auth = { user: { id: userId }, session: { id: '19a00000-0000-4000-8000-000000000002' } };
const id = '19a00000-0000-4000-8000-000000000003';
const body = { name: "literal'; DROP TABLE images; --.png", mimeType: 'image/png', fileData: images.png,
  width: 3, height: 2, bounds: metadata.bounds, angle: 0, opacity: .65, locked: false };
function fixture({ fail, failRollback = false, commitGate, badJson = false, clientError = false } = {}) {
  const operations = [], releases = [];
  const client = new EventEmitter();
  client.query = async (sql, values) => {
    const kind = sql.includes('INSERT INTO images') ? 'insert' : sql;
    operations.push({ kind, values });
    if (kind === 'insert' && clientError) { client.emit('error', new Error('TOP_SECRET connection')); throw new Error('TOP_SECRET connection'); }
    if (kind === fail || (kind === 'ROLLBACK' && failRollback)) throw new Error('TOP_SECRET SQL postgresql://owner:password@host/db');
    if (kind === 'COMMIT') await commitGate?.();
    return { rows: kind === 'insert' ? [{ id, user_id: userId, file_data: images.png, name: body.name, mime_type: 'image/png',
      size_bytes: images.png.length, width: 3, height: 2, south: 54.6, west: 39.7, north: 54.7, east: 39.8,
      angle: badJson ? 1n : 0, opacity: .65, locked: false, revision: 1,
      created_at: '2026-11-14T00:00:00.123456Z', updated_at: '2026-11-14T00:00:00.123456Z' }] : [] };
  };
  client.release = destroy => releases.push(destroy);
  const database = { pool: { async connect() {
    operations.push({ kind: 'connect' });
    if (fail === 'connect') throw new Error('TOP_SECRET credentials');
    return client;
  } } };
  return { handler: createImageUploadHandler({ database }), operations, releases, client };
}
function safe(error, code = 'DATABASE_UNAVAILABLE') {
  assert.equal(error.code, code);
  assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|postgresql|password@/);
  return true;
}

test('P19 upload rejects guests and invalid trusted identity before obtaining a transaction client', async () => {
  const f = fixture();
  for (const identity of [null, {}, { user: { id: userId } }, { ...auth, session: null }, { ...auth, user: { id: 'forged' } }]) {
    await assert.rejects(f.handler({ auth: identity, body }), { code: 'AUTH_REQUIRED', status: 401 });
  }
  assert.deepEqual(f.operations, []);
});

test('P19 upload binds the session owner and exact bytes, and returns safe 201 only after COMMIT', async () => {
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ commitGate: async () => { reached(); await gate; } });
  let settled = false;
  const pending = f.handler({ auth, body }).then(response => { settled = true; return response; });
  await entered; assert.equal(settled, false); release();
  const response = await pending;
  assert.equal(response.status, 201);
  const value = await response.json();
  assert.deepEqual(Object.keys(value), ['image']);
  assert.deepEqual(Object.keys(value.image).sort(), ['id', 'name', 'mimeType', 'sizeBytes', 'width', 'height', 'bounds', 'angle', 'opacity', 'locked', 'revision', 'createdAt', 'updatedAt', 'fileUrl'].sort());
  assert.equal(value.image.id, id); assert.equal(value.image.name, body.name);
  assert.equal(value.image.fileUrl, `/api/images/${id}/file`);
  const insert = f.operations.find(operation => operation.kind === 'insert');
  assert.equal(insert.values[0], userId); assert.deepEqual(insert.values[3], images.png);
  assert.deepEqual(f.operations.map(o => o.kind), ['connect', 'BEGIN', 'insert', 'COMMIT']);
  assert.deepEqual(f.releases, [false]); assert.equal(f.client.listenerCount('error'), 0);
});

test('P19 INSERT or connection failure never returns success or exposes driver data', async () => {
  for (const fail of ['connect', 'insert']) {
    const f = fixture({ fail });
    await assert.rejects(f.handler({ auth, body }), error => safe(error));
    assert.ok(!f.operations.some(o => o.kind === 'COMMIT'));
    if (fail === 'insert') { assert.equal(f.operations.at(-1).kind, 'ROLLBACK'); assert.deepEqual(f.releases, [false]); }
    else assert.deepEqual(f.releases, []);
  }
});

test('P19 response construction failure rolls back the image before committing', async () => {
  const f = fixture({ badJson: true });
  await assert.rejects(f.handler({ auth, body }), error => safe(error, 'INTERNAL_ERROR'));
  assert.deepEqual(f.operations.map(o => o.kind), ['connect', 'BEGIN', 'insert', 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
});

test('P19 uncertain transaction acknowledgement discards the client without automatic upload retry', async () => {
  for (const options of [{ fail: 'BEGIN' }, { fail: 'COMMIT' }, { fail: 'insert', failRollback: true }]) {
    const f = fixture(options);
    await assert.rejects(f.handler({ auth, body }), error => safe(error));
    assert.deepEqual(f.releases, [true]);
    assert.ok(f.operations.filter(o => o.kind === 'insert').length <= 1);
    assert.ok(f.operations.filter(o => o.kind === 'COMMIT').length <= 1);
    assert.equal(f.client.listenerCount('error'), 0);
  }
});

test('P19 checked-out client errors do not escape as unhandled events or leak data', async () => {
  const f = fixture({ clientError: true });
  await assert.rejects(f.handler({ auth, body }), error => safe(error));
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.client.listenerCount('error'), 0);
  assert.equal(f.operations.filter(o => o.kind === 'insert').length, 1);
});
