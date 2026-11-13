import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageRepository } from '../src/backend/image-repository.mjs';

const owner = '17a00000-0000-4000-8000-000000000001';
const id = '17a00000-0000-4000-8000-000000000002';
const auth = { user: { id: owner }, session: { id: '17a00000-0000-4000-8000-000000000003' } };
const row = { id, user_id: owner, name: "карта'; DROP TABLE images; --.png", mime_type: 'image/png',
  size_bytes: 3, file_data: Buffer.from([1, 2, 3]), width: 1, height: 1,
  south: 54.6, west: 39.7, north: 54.7, east: 39.8, angle: 0, opacity: .65, locked: false, revision: 1,
  created_at: '2026-11-13T00:00:00.123456Z', updated_at: '2026-11-13T00:00:00.123456Z' };
const data = { name: row.name, mimeType: 'image/png', fileData: row.file_data, width: 1, height: 1, bounds: [[54.6, 39.7], [54.7, 39.8]] };
function fixture(rows = [row]) {
  const queries = [];
  const client = { async query(sql, values) { queries.push({ sql, values }); return { rows }; } };
  return { repository: createImageRepository({ database: { pool: client } }), queries, client };
}

test('P17 reads reject guests/invalid identities before SQL or record validation', async () => {
  const f = fixture();
  for (const identity of [null, {}, { user: { id: owner } }, { ...auth, user: { id: "' OR true--" } }, { ...auth, session: null }]) {
    for (const action of [() => f.repository.get(identity, 'bad'), () => f.repository.getFile(identity, 'bad'),
      () => f.repository.list(identity, { userId: owner })]) await assert.rejects(action(), { code: 'AUTH_REQUIRED', status: 401 });
  }
  assert.equal(f.queries.length, 0);
});

test('P17 rejects malformed UUIDs, owner substitution and injected pagination before SQL', async () => {
  const f = fixture();
  for (const invalid of [null, 17, "' OR 1=1 --", id + "';DROP TABLE users--"]) {
    await assert.rejects(f.repository.get(auth, invalid), { code: 'VALIDATION_ERROR' });
    await assert.rejects(f.repository.getFile(auth, invalid), { code: 'VALIDATION_ERROR' });
  }
  for (const options of [null, [], { userId: id }, { user_id: id }, { limit: '1; DROP TABLE images' },
    { limit: 0 }, { limit: 101 }, { after: { id, createdAt: '2026-02-30T00:00:00.123456Z' } },
    { after: { id: "' OR true--", createdAt: row.created_at } }, { after: { id, createdAt: row.created_at, userId: id } }]) {
    await assert.rejects(f.repository.list(auth, options), { code: 'VALIDATION_ERROR', status: 400 });
  }
  assert.equal(f.queries.length, 0);
});

test('P17 projections expose only metadata or explicitly requested bytes; query values stay bound', async () => {
  const f = fixture();
  const image = await f.repository.get(auth, id);
  assert.deepEqual(Object.keys(image).sort(), ['id', 'name', 'mimeType', 'sizeBytes', 'width', 'height', 'bounds', 'angle', 'opacity', 'locked', 'revision', 'createdAt', 'updatedAt', 'fileUrl'].sort());
  assert.equal(image.name, row.name);
  assert.deepEqual(image.bounds, [[54.6, 39.7], [54.7, 39.8]]);
  assert.equal(image.createdAt, row.created_at);
  assert.deepEqual(await f.repository.getFile(auth, id), { data: row.file_data, mimeType: 'image/png', sizeBytes: 3 });
  assert.equal((await f.repository.list(auth)).images[0].fileUrl, `/api/images/${id}/file`);
  for (const { sql, values } of f.queries) {
    assert.equal(values[0], owner);
    assert.ok(!sql.includes(owner) && !sql.includes(id));
    assert.doesNotMatch(sql, /SELECT\s+\*/i);
    assert.match(sql, /i\.user_id = \$1::uuid/);
  }
});

test('P17 pagination keeps microseconds, binds the boundary and never returns the lookahead row', async () => {
  const second = { ...row, id: '17a00000-0000-4000-8000-000000000004', created_at: '2026-11-13T00:00:00.123457Z' };
  const f = fixture([row, second]);
  const page = await f.repository.list(auth, { limit: 1, after: { id, createdAt: row.created_at } });
  assert.equal(page.images.length, 1);
  assert.deepEqual(page.next, { id, createdAt: row.created_at });
  assert.deepEqual(f.queries[0].values, [owner, row.created_at, id, 2]);
  assert.deepEqual(await fixture([]).repository.list(auth), { images: [], next: null });
});

test('P17 foreign/missing records use one safe 404 and driver failures use a sanitized 503', async () => {
  const empty = fixture([]).repository;
  for (const method of ['get', 'getFile']) await assert.rejects(empty[method](auth, id), { code: 'NOT_FOUND', status: 404 });
  const repository = createImageRepository({ database: { pool: { query() { throw new Error('SQL TOP_SECRET postgresql://owner:password@host/db'); } } } });
  for (const action of [() => repository.get(auth, id), () => repository.getFile(auth, id), () => repository.list(auth)]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, 'DATABASE_UNAVAILABLE'); assert.equal(error.status, 503);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|postgresql|password@/);
      return true;
    });
  }
});

test('P17 caller-owned read clients are reused without transaction or lifecycle operations', async () => {
  const f = fixture();
  const repository = createImageRepository({ database: { pool: { query() { throw new Error('Wrong pool'); } } } });
  await repository.get(auth, id, { client: f.client });
  await repository.getFile(auth, id, { client: f.client });
  await repository.list(auth, {}, { client: f.client });
  assert.equal(f.queries.length, 3);
  assert.ok(f.queries.every(q => q.sql.startsWith('SELECT')));
});

test('P17 write guards reject guests, owner/byte changes and injected keys before SQL', async () => {
  const f = fixture();
  for (const action of [() => f.repository.create(null, {}), () => f.repository.update(null, 'bad', {}), () => f.repository.remove(null, 'bad')]) {
    await assert.rejects(action(), { code: 'AUTH_REQUIRED', status: 401 });
  }
  for (const extra of [{ userId: id }, { user_id: id }, { id }, { sizeBytes: 1 }, { 'name) VALUES (NULL); DROP TABLE images; --': 'x' }]) {
    await assert.rejects(f.repository.create(auth, { ...data, ...extra }), { code: 'VALIDATION_ERROR' });
  }
  for (const changes of [{ revision: 1 }, { revision: 0, angle: 1 }, { revision: '1 OR true', angle: 1 },
    { revision: 1, user_id: id, angle: 1 }, { revision: 1, userId: id, angle: 1 }, { revision: 1, fileData: Buffer.from('x') },
    { revision: 1, name: 'renamed.png' }, { revision: 1, opacity: '0; DELETE FROM users' },
    { revision: 1, 'opacity = 1 WHERE true; --': 1 }, { revision: 1, bounds: [[0, NaN], [1, 2]] },
    { revision: 1, locked: 'false' }]) await assert.rejects(f.repository.update(auth, id, changes), { code: 'VALIDATION_ERROR' });
  await assert.rejects(f.repository.remove(auth, "' OR true--"), { code: 'VALIDATION_ERROR' });
  assert.equal(f.queries.length, 0);
});

test('P17 writes bind all values and use session owner while returning only safe metadata', async () => {
  const f = fixture();
  const created = await f.repository.create(auth, data);
  assert.equal(created.name, data.name);
  assert.deepEqual(f.queries[0].values, [owner, data.name, 'image/png', data.fileData, 1, 1, 54.6, 39.7, 54.7, 39.8, 0, .65, false]);
  await f.repository.update(auth, id, { revision: 1, bounds: [[-1, -2], [1, 2]], angle: 0, opacity: 0, locked: false });
  assert.deepEqual(f.queries[1].values, [owner, id, 1, -1, -2, 1, 2, 0, 0, false]);
  assert.match(f.queries[1].sql, /i\.revision = \$3::integer/);
  await f.repository.remove(auth, id);
  for (const { sql, values } of f.queries) {
    assert.equal(values[0], owner);
    assert.ok(!sql.includes(owner) && !sql.includes(id) && !sql.includes(data.name));
  }
  assert.ok(!Object.hasOwn(created, 'fileData') && !Object.hasOwn(created, 'user_id'));
});

test('P17 CAS failure distinguishes only an owned conflict from the common missing/foreign 404', async () => {
  for (const [rows, expected] of [[[{ id }], 'REVISION_CONFLICT'], [[], 'NOT_FOUND']]) {
    const calls = [];
    const repository = createImageRepository({ database: { pool: { async query(sql, values) {
      calls.push({ sql, values }); return { rows: calls.length === 1 ? [] : rows };
    } } } });
    await assert.rejects(repository.update(auth, id, { revision: 1, angle: 5 }), { code: expected });
    assert.equal(calls.length, 2);
    for (const query of calls) { assert.equal(query.values[0], owner); assert.match(query.sql, /i\.user_id = \$1::uuid/); }
  }
  await assert.rejects(fixture([]).repository.remove(auth, id), { code: 'NOT_FOUND' });
  const failing = createImageRepository({ database: { pool: { query() { throw new Error('TOP_SECRET SQL bytea credentials'); } } } });
  for (const action of [() => failing.create(auth, data), () => failing.update(auth, id, { revision: 1, locked: true }), () => failing.remove(auth, id)]) {
    await assert.rejects(action(), e => e.code === 'DATABASE_UNAVAILABLE' && !/TOP_SECRET|bytea|credentials/.test(e.stack + JSON.stringify(e)));
  }
});

test('P17 caller-owned write clients receive no implicit commit, rollback, release or retry', async () => {
  const f = fixture();
  const repository = createImageRepository({ database: { pool: { query() { throw new Error('Wrong pool'); } } } });
  await repository.create(auth, data, { client: f.client });
  await repository.update(auth, id, { revision: 1, opacity: .25 }, { client: f.client });
  await repository.remove(auth, id, { client: f.client });
  assert.equal(f.queries.length, 3);
  assert.ok(f.queries.every(({ sql }) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)));
});
