import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    pool = new Pool({ ...config, max: 4, application_name: schema, options: `-c search_path=${schema},pg_catalog` });
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
    await work({ pool, schema, repository, a: identities[0], b: identities[1], sessions, queryCount: () => queryCount });
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

test('P17 creates atomic bytes/metadata for the session owner and refuses supplied ownership or IDs', async () => {
  await isolated(async ({ pool, repository, a, b }) => {
    const name = "literal'); DELETE FROM users; --.png";
    const { angle, opacity, locked, ...minimal } = imageData;
    const image = await repository.create(a, { ...minimal, name });
    assert.deepEqual([image.name, image.angle, image.opacity, image.locked, image.revision], [name, 0, .65, false, 1]);
    assert.deepEqual(image.bounds, imageData.bounds);
    const raw = (await pool.query('SELECT user_id,file_data FROM images WHERE id=$1', [image.id])).rows[0];
    assert.equal(raw.user_id, a.user.id); assert.deepEqual(raw.file_data, png);
    for (const fields of [{ userId: b.user.id }, { user_id: b.user.id }, { id: randomUUID() }]) {
      await assert.rejects(repository.create(a, { ...imageData, ...fields }), { code: 'VALIDATION_ERROR', status: 400 });
    }
    assert.equal((await repository.list(b)).images.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
  });
});

test('P17 foreign/missing mutations share 404 for any revision and guests never reach SQL', async () => {
  await isolated(async ({ pool, repository, a, b, queryCount }) => {
    const id = await seed(pool, a.user.id);
    const saved = (await pool.query('SELECT * FROM images WHERE id=$1', [id])).rows[0];
    const before = queryCount();
    for (const action of [() => repository.create(null, imageData), () => repository.update(null, id, { revision: 1, opacity: 0 }), () => repository.remove(null, id)]) {
      await assert.rejects(action(), { code: 'AUTH_REQUIRED', status: 401 });
    }
    assert.equal(queryCount(), before);
    for (const otherId of [id, randomUUID()]) {
      for (const revision of [1, 999]) await assert.rejects(repository.update(b, otherId, { revision, opacity: 0 }), { code: 'NOT_FOUND', status: 404 });
      await assert.rejects(repository.remove(b, otherId), { code: 'NOT_FOUND', status: 404 });
    }
    for (const extra of [{ userId: b.user.id }, { user_id: b.user.id }, { fileData: Buffer.from('changed') }, { 'opacity = 0 WHERE true; --': 0 }]) {
      await assert.rejects(repository.update(a, id, { revision: 1, opacity: .1, ...extra }), { code: 'VALIDATION_ERROR', status: 400 });
    }
    assert.deepEqual((await pool.query('SELECT * FROM images WHERE id=$1', [id])).rows[0], saved);
  });
});

test('P17 own edits preserve owner/bytes, compare revisions and delete without revealing missing records', async () => {
  await isolated(async ({ pool, repository, a }) => {
    const image = await repository.create(a, imageData);
    const bounds = [[-85, -180], [85, 180]];
    const edited = await repository.update(a, image.id, { revision: 1, bounds, angle: -180, opacity: 0, locked: true });
    assert.deepEqual([edited.bounds, edited.angle, edited.opacity, edited.locked, edited.revision], [bounds, -180, 0, true, 2]);
    assert.equal(edited.createdAt, image.createdAt); assert.ok(edited.updatedAt >= image.updatedAt);
    const raw = (await pool.query('SELECT user_id,file_data FROM images WHERE id=$1', [image.id])).rows[0];
    assert.equal(raw.user_id, a.user.id); assert.deepEqual(raw.file_data, png);
    await assert.rejects(repository.update(a, image.id, { revision: 1, opacity: 1 }), { code: 'REVISION_CONFLICT', status: 409 });
    assert.deepEqual(await repository.get(a, image.id), edited);
    const third = await repository.update(a, image.id, { revision: 2, angle: 0, opacity: 1, locked: false });
    assert.deepEqual([third.angle, third.opacity, third.locked, third.revision], [0, 1, false, 3]);
    assert.equal(await repository.remove(a, image.id), undefined);
    assert.equal((await repository.list(a)).images.length, 0);
    for (const method of ['get', 'getFile', 'remove']) await assert.rejects(repository[method](a, image.id), { code: 'NOT_FOUND', status: 404 });
    await assert.rejects(repository.update(a, image.id, { revision: 3, opacity: .5 }), { code: 'NOT_FOUND', status: 404 });
  });
});

test('P17 overlapping updates at one revision have one winner and cannot overwrite the newer value', async () => {
  await isolated(async ({ pool, schema, repository, a, b }) => {
    const image = await repository.create(a, imageData), foreign = await repository.create(b, imageData);
    const blocker = await pool.connect();
    let pending;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM images WHERE id=$1 FOR UPDATE', [image.id]);
      pending = Promise.allSettled([11, 22].map(angle => repository.update(a, image.id, { revision: 1, angle })));
      // Both real UPDATE statements must be waiting on the row, not merely two
      // sequential calls. This observer uses the same ordinary PostgreSQL role.
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 2; i++) {
        waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE images AS i SET%'`, [schema])).rows[0].n;
        if (waiting < 2) await delay(10);
      }
      assert.equal(waiting, 2, 'both writers are blocked concurrently');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const results = await pending;
    const winners = results.filter(r => r.status === 'fulfilled'), failures = results.filter(r => r.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.code, 'REVISION_CONFLICT');
    const saved = await repository.get(a, image.id);
    assert.deepEqual(saved, winners[0].value); assert.equal(saved.revision, 2);
    assert.equal((await repository.get(b, foreign.id)).revision, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 2);
  });
});

test('P17 supplied transaction clients keep create/update/delete atomic and caller controlled', async () => {
  await isolated(async ({ pool, repository, a }) => {
    const existing = await repository.create(a, imageData), removable = await repository.create(a, imageData);
    const client = await pool.connect();
    let rolledBackId;
    try {
      await client.query('BEGIN');
      const created = await repository.create(a, imageData, { client }); rolledBackId = created.id;
      await repository.update(a, existing.id, { revision: 1, angle: 45 }, { client });
      await repository.remove(a, removable.id, { client });
      assert.equal((await repository.get(a, existing.id, { client })).angle, 45);
      assert.equal((await repository.get(a, existing.id)).angle, 0);
      await assert.rejects(repository.get(a, created.id), { code: 'NOT_FOUND' });
      await client.query('ROLLBACK');
      assert.equal((await repository.get(a, existing.id)).revision, 1);
      assert.equal((await repository.get(a, removable.id)).id, removable.id);
      await assert.rejects(repository.get(a, rolledBackId), { code: 'NOT_FOUND' });
      await client.query('BEGIN');
      const committed = await repository.create(a, imageData, { client });
      await repository.update(a, committed.id, { revision: 1, locked: true }, { client });
      await client.query('COMMIT');
      assert.equal((await repository.get(a, committed.id)).locked, true);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

test('P17 real write failures stay sanitized and leave bytes/metadata unchanged', async () => {
  await isolated(async ({ pool, repository, a }) => {
    const image = await repository.create(a, imageData);
    const before = (await pool.query('SELECT * FROM images WHERE id=$1', [image.id])).rows[0];
    await pool.query("CREATE FUNCTION p17_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P17_SQL_SECRET'; END; $$");
    await pool.query('CREATE TRIGGER p17_fail BEFORE INSERT OR UPDATE OR DELETE ON images FOR EACH ROW EXECUTE FUNCTION p17_fail()');
    for (const action of [() => repository.create(a, imageData), () => repository.update(a, image.id, { revision: 1, opacity: 0 }), () => repository.remove(a, image.id)]) {
      await assert.rejects(action(), error => {
        assert.equal(error.code, 'DATABASE_UNAVAILABLE'); assert.equal(error.status, 503);
        assert.doesNotMatch(error.stack + JSON.stringify(error), /P17_SQL_SECRET|p17_fail|INSERT|UPDATE|DELETE|postgresql/);
        return true;
      });
    }
    assert.deepEqual((await pool.query('SELECT * FROM images WHERE id=$1', [image.id])).rows[0], before);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 1);
  });
});
