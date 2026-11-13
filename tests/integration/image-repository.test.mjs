import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations } from '../../src/backend/migrations.mjs';
import { readAuthConfig } from '../../src/backend/auth-config.mjs';
import { createSessionService } from '../../src/backend/sessions.mjs';
import { createImageRepository } from '../../src/backend/image-repository.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const config = readDatabaseConfig();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XGW0AAAAASUVORK5CYII=', 'base64');
const imageData = { name: 'карта.png', mimeType: 'image/png', fileData: png, width: 1, height: 1,
  bounds: [[54.6, 39.7], [54.7, 39.8]], angle: 0, opacity: .65, locked: false };

async function isolated(work) {
  const database = createDatabase();
  const schema = 'p17_test_' + randomUUID().replaceAll('-', '');
  let pool;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    await applyMigrations(pool);
    const sessions = createSessionService({ database: { pool }, config: readAuthConfig({ PUBLIC_ORIGIN: 'https://map.example.test' }) });
    const identities = [];
    for (const name of ['A', 'B']) {
      const { rows: [user] } = await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id,email,name',
        [`p17-${randomUUID()}@example.test`, name, 'P17_TEST_ONLY_NOT_A_LOGIN_HASH']);
      const issued = await sessions.issue(user.id);
      identities.push(await sessions.resolve(new Headers({ Cookie: issued.cookie.split(';')[0] })));
    }
    let queryCount = 0;
    const repository = createImageRepository({ database: { pool: {
      query(...args) { queryCount++; return pool.query(...args); }, connect: pool.connect.bind(pool),
    } } });
    await work({ pool, repository, a: identities[0], b: identities[1], sessions, queryCount: () => queryCount });
  } finally {
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}
async function seed(pool, userId, { id = randomUUID(), name = imageData.name, createdAt = '2026-11-13T00:00:00.123456Z' } = {}) {
  await pool.query(`INSERT INTO images (id,user_id,name,mime_type,file_data,width,height,south,west,north,east,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,1,1,54.6,39.7,54.7,39.8,$6,$6)`, [id,userId,name,'image/png',png,createdAt]);
  return id;
}

test('P17 real sessions A/B see only their metadata/bytes; foreign and missing UUIDs share 404', async () => {
  await isolated(async ({ pool, repository, a, b }) => {
    const aid = await seed(pool, a.user.id), bid = await seed(pool, b.user.id);
    for (const [auth, own, foreign] of [[a, aid, bid], [b, bid, aid]]) {
      const page = await repository.list(auth);
      assert.deepEqual(page.images.map(i => i.id), [own]);
      assert.equal(page.next, null);
      const image = await repository.get(auth, own);
      assert.equal(image.id, own); assert.equal(image.sizeBytes, png.length);
      assert.equal(image.createdAt, '2026-11-13T00:00:00.123456Z');
      for (const key of ['user_id', 'userId', 'file_data', 'fileData']) assert.ok(!Object.hasOwn(image, key));
      assert.deepEqual(await repository.getFile(auth, own), { data: png, mimeType: 'image/png', sizeBytes: png.length });
      for (const method of ['get', 'getFile']) {
        for (const id of [foreign, randomUUID()]) await assert.rejects(repository[method](auth, id), { code: 'NOT_FOUND', status: 404 });
      }
    }
  });
});

test('P17 keyset pages preserve microseconds/ties and cannot widen ownership with a foreign boundary', async () => {
  await isolated(async ({ pool, repository, a, b }) => {
    const ids = [1, 2, 3, 4].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
    for (let i = 0; i < ids.length; i++) await seed(pool, a.user.id, { id: ids[i], createdAt: `2026-11-13T00:00:00.${i < 2 ? '123451' : '123452'}Z` });
    const foreign = await seed(pool, b.user.id, { createdAt: '2026-11-13T00:00:00.123451Z' });
    const seen = []; let after = null;
    do {
      const page = await repository.list(a, { limit: 1, after });
      seen.push(...page.images.map(image => image.id)); after = page.next;
    } while (after);
    assert.deepEqual(seen, ids);
    const page = await repository.list(a, { after: { id: foreign, createdAt: '2026-11-13T00:00:00.123451Z' } });
    assert.ok(page.images.every(image => ids.includes(image.id)));
    assert.ok(!page.images.some(image => image.id === foreign));
    assert.equal((await repository.list(b)).images.length, 1);
  });
});

test('P17 guest, forged owner/IDs and injection attempts fail before SQL; names remain literal data', async () => {
  await isolated(async ({ pool, repository, a, b, sessions, queryCount }) => {
    const name = "карта'); DROP TABLE users; --.png";
    const id = await seed(pool, a.user.id, { name });
    await sessions.revoke(b.session.id);
    const guest = await sessions.resolve(new Headers());
    assert.equal(guest, null);
    const before = queryCount();
    for (const action of [() => repository.get(guest, id), () => repository.getFile(guest, id), () => repository.list(guest)]) {
      await assert.rejects(action(), { code: 'AUTH_REQUIRED', status: 401 });
    }
    for (const action of [() => repository.get(a, "' OR 1=1--"), () => repository.getFile(a, id + "'; DELETE FROM images--"),
      () => repository.list(a, { user_id: b.user.id }), () => repository.list(a, { userId: b.user.id }),
      () => repository.list(a, { limit: '1; DROP TABLE users' })]) await assert.rejects(action(), { code: 'VALIDATION_ERROR', status: 400 });
    assert.equal(queryCount(), before);
    assert.equal((await repository.get(a, id)).name, name);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
  });
});

test('P17 real PostgreSQL query failures return a fixed 503 without SQL or owner details', async () => {
  await isolated(async ({ pool, repository, a }) => {
    await pool.query('DROP VIEW image_metadata');
    await assert.rejects(repository.list(a), error => {
      assert.equal(error.code, 'DATABASE_UNAVAILABLE'); assert.equal(error.status, 503);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /image_metadata|p17_test_|SELECT|postgresql|password_hash/);
      assert.ok(!JSON.stringify(error).includes(a.user.id)); return true;
    });
  });
});
