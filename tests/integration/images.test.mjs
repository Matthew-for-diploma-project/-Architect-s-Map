import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { createDatabase } from '../../src/backend/database.mjs';
import { readDatabaseConfig } from '../../src/backend/database-config.mjs';
import { applyMigrations, loadMigrations } from '../../src/backend/migrations.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('Для интеграционных тестов нужен NODE_ENV=test.');
const config = readDatabaseConfig(); // Validate isolation before creating any schema.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XGW0AAAAASUVORK5CYII=', 'base64');

async function isolatedSchema(fn) {
  const database = createDatabase();
  const schema = 'p05_test_' + randomUUID().replaceAll('-', '');
  let pool;
  try {
    await database.pool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},pg_catalog` });
    pool.on('error', () => {});
    return await fn(pool, schema);
  } finally {
    await pool?.end();
    await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.close();
  }
}

async function user(pool) {
  return (await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [`${randomUUID()}@example.test`, 'Проверка P05', 'scrypt$P05_TEST_ONLY$salt$params$hash'])).rows[0];
}

async function image(pool, userId, overrides = {}) {
  // Keys originate only from controlled test code, never external input.
  const values = { user_id: userId, name: 'карта.png', mime_type: 'image/png', file_data: png,
    width: 1, height: 1, south: 54.6, west: 39.7, north: 54.7, east: 39.8, ...overrides };
  const keys = Object.keys(values);
  const placeholders = keys.map((key, index) => '$' + (index + 1));
  return (await pool.query(`INSERT INTO images (${keys.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`, Object.values(values))).rows[0].id;
}

test('P05 upgrades P04, backfills layer settings and preserves existing data on repeat', async () => {
  await isolatedSchema(async pool => {
    const [first, second] = await loadMigrations();
    const directory = await mkdtemp(path.join(tmpdir(), 'geokontekst-images-'));
    try {
      await writeFile(path.join(directory, first.name), first.sql);
      await applyMigrations(pool, { directory });
      const account = await user(pool);
      const oldHistory = (await pool.query('SELECT * FROM schema_migrations')).rows[0];
      const result = await applyMigrations(pool);
      assert.deepEqual(result.applied, [second.name]);
      assert.deepEqual(result.skipped, [first.name]);
      assert.deepEqual((await pool.query('SELECT * FROM users')).rows, [account]);
      assert.deepEqual((await pool.query('SELECT * FROM schema_migrations WHERE version = 1')).rows[0], oldHistory);
      const settings = (await pool.query('SELECT * FROM layer_settings WHERE user_id=$1', [account.id])).rows[0];
      assert.equal(settings.opacity, 1);
      assert.equal(settings.revision, 1);
      await pool.query('UPDATE layer_settings SET opacity=.25, revision=revision+1, updated_at=clock_timestamp() WHERE user_id=$1', [account.id]);
      const saved = (await pool.query('SELECT * FROM layer_settings')).rows;
      assert.equal((await applyMigrations(pool)).applied.length, 0);
      assert.deepEqual((await pool.query('SELECT * FROM layer_settings')).rows, saved);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('image bytes round trip exactly and georeferencing/individual settings persist', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    const id = await image(pool, account.id);
    const first = (await pool.query('SELECT * FROM image_metadata WHERE id=$1', [id])).rows[0];
    assert.equal(first.size_bytes, png.length);
    assert.equal(first.opacity, 0.65);
    assert.equal(first.angle, 0);
    assert.equal(first.locked, false);
    assert.equal(first.revision, 1);
    assert.ok(first.created_at instanceof Date);
    await pool.query('UPDATE images SET south=$1, west=$2, north=$3, east=$4, angle=$5, opacity=$6, locked=$7, revision=revision+1, updated_at=clock_timestamp() WHERE id=$8', [54.61, 39.71, 54.72, 39.83, -37, 0.333, true, id]);
    const changed = (await pool.query('SELECT * FROM image_metadata WHERE id=$1', [id])).rows[0];
    assert.deepEqual([changed.south, changed.west, changed.north, changed.east], [54.61,39.71,54.72,39.83]);
    assert.deepEqual([changed.angle, changed.opacity, changed.locked, changed.revision], [-37,0.333,true,2]);
    assert.ok(changed.updated_at >= changed.created_at);
    assert.equal((await pool.query('SELECT file_data FROM images WHERE id=$1 AND user_id=$2', [id,account.id])).rows[0].file_data.equals(png), true);
  });
});

test('metadata listing omits binary data and uses stored size and owner pagination index', async () => {
  await isolatedSchema(async (pool, schema) => {
    await applyMigrations(pool);
    const a = await user(pool), b = await user(pool);
    await image(pool, a.id);
    await image(pool, b.id);
    const list = await pool.query('SELECT * FROM image_metadata WHERE user_id=$1 ORDER BY created_at,id LIMIT 50', [a.id]);
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0].user_id, a.id);
    assert.ok(!list.fields.some(field => field.name === 'file_data'));
    assert.ok(Object.values(list.rows[0]).every(value => !Buffer.isBuffer(value)));
    await assert.rejects(pool.query('SELECT file_data FROM image_metadata'), { code: '42703' });
    const plan = await pool.query('EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM image_metadata WHERE user_id=$1 ORDER BY created_at,id LIMIT 50', [a.id]);
    assert.ok(!JSON.stringify(plan.rows).includes('file_data'));
    const generated = (await pool.query("SELECT is_generated FROM information_schema.columns WHERE table_schema=$1 AND table_name='images' AND column_name='size_bytes'", [schema])).rows[0];
    assert.equal(generated.is_generated, 'ALWAYS');
    const index = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='images_user_created_id_idx'", [schema])).rows[0].indexdef;
    assert.match(index, /\(user_id, created_at, id\)/);
  });
});

test('file size is derived from bytea and the inclusive 20 MiB limit is enforced', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    await assert.rejects(image(pool, account.id, { file_data: Buffer.alloc(0) }), { code: '23514' });
    // Size/storage checks only; decoding and content-vs-MIME validation belong to P18.
    const maximum = Buffer.alloc(20 * 1024 * 1024, 7);
    const id = await image(pool, account.id, { file_data: maximum });
    assert.equal((await pool.query('SELECT size_bytes FROM image_metadata WHERE id=$1', [id])).rows[0].size_bytes, maximum.length);
    await assert.rejects(image(pool, account.id, { file_data: Buffer.alloc(maximum.length + 1) }), { code: '23514' });
    await assert.rejects(image(pool, account.id, { size_bytes: 1 }), { code: '428C9' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 1);
  });
});

test('WGS84 bounds reject nonfinite, reversed and out-of-range coordinates', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    const cases = [{south:-85.01}, {north:85.01}, {west:-180.01}, {east:180.01}, {south:54.7}, {north:54.6}, {west:39.8}, {east:39.7}, {west:170,east:-170}];
    for (const key of ['south','west','north','east']) for (const value of [NaN,Infinity,-Infinity]) cases.push({[key]:value});
    for (const bounds of cases) await assert.rejects(image(pool, account.id, bounds), { code: '23514' });
    await image(pool, account.id, {south:-85,west:-180,north:85,east:180});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n, 1);
  });
});

test('pixel dimensions enforce axis limits, total pixels and overflow-safe checks', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    for (const dimensions of [{width:0},{height:-1},{width:16385},{height:16385},{width:16384,height:16384},{width:2147483647,height:2147483647}]) {
      await assert.rejects(image(pool, account.id, dimensions), { code: '23514' });
    }
    await image(pool, account.id, {width:10000,height:4000});
    await image(pool, account.id, {width:16384,height:1});
    await assert.rejects(image(pool, account.id, {width:10000,height:4001}), { code: '23514' });
  });
});

test('image opacity, angle, revision and dates reject invalid state', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    for (const invalid of [{opacity:-.01},{opacity:1.01},{opacity:NaN},{opacity:Infinity},{angle:-181},{angle:181},{revision:0},{revision:-1},{updated_at:new Date(0)},{created_at:'infinity'},{updated_at:'infinity'}]) {
      await assert.rejects(image(pool, account.id, invalid), { code: '23514' });
    }
    await image(pool, account.id, {opacity:0,angle:-180});
    await image(pool, account.id, {opacity:1,angle:180});
    await assert.rejects(image(pool, account.id, {angle:1.5}), { code: '22P02' });
  });
});

test('names and MIME are constrained without requiring a filename extension', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    for (const name of ['', ' ', '.', '..', 'a/b.png', 'a\\b.png', 'a\nb.png', 'x'.repeat(256)]) {
      await assert.rejects(image(pool, account.id, {name}), { code: '23514' });
    }
    for (const mime_type of ['image/svg+xml','text/html','image/jpg','IMAGE/PNG']) {
      await assert.rejects(image(pool, account.id, {mime_type}), { code: '23514' });
    }
    for (const mime_type of ['image/png','image/jpeg','image/webp']) await image(pool, account.id, {mime_type,name:'план'});
    await image(pool, account.id, {name:'🏠'.repeat(255)});
  });
});

test('image/settings ownership, required values and one setting per user are enforced', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    await assert.rejects(image(pool, randomUUID()), { code: '23503' });
    for (const key of ['user_id','name','mime_type','file_data','width','height','south','west','north','east','angle','opacity','locked','revision','created_at','updated_at']) {
      await assert.rejects(image(pool, account.id, {[key]:null}), { code: '23502' });
    }
    await assert.rejects(pool.query('INSERT INTO layer_settings(user_id) VALUES($1)', [randomUUID()]), { code:'23503' });
    await assert.rejects(pool.query('INSERT INTO layer_settings(user_id) VALUES(NULL)'), { code:'23502' });
    await pool.query('INSERT INTO layer_settings(user_id) VALUES($1)', [account.id]);
    await assert.rejects(pool.query('INSERT INTO layer_settings(user_id) VALUES($1)', [account.id]), { code:'23505' });
  });
});

test('general opacity survives an empty image list and does not change individual opacity', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const account = await user(pool);
    const first = (await pool.query('INSERT INTO layer_settings(user_id) VALUES($1) RETURNING *', [account.id])).rows[0];
    assert.equal(first.opacity, 1);
    assert.equal(first.revision, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_metadata')).rows[0].n, 0);
    for (const opacity of [0,.377,1]) await pool.query('UPDATE layer_settings SET opacity=$1, revision=revision+1, updated_at=clock_timestamp() WHERE user_id=$2', [opacity,account.id]);
    const id = await image(pool, account.id, {opacity:.4});
    await pool.query('UPDATE layer_settings SET opacity=.2, revision=revision+1, updated_at=clock_timestamp() WHERE user_id=$1', [account.id]);
    assert.equal((await pool.query('SELECT opacity FROM image_metadata WHERE id=$1',[id])).rows[0].opacity,.4);
    const saved = (await pool.query('SELECT * FROM layer_settings WHERE user_id=$1',[account.id])).rows[0];
    await applyMigrations(pool);
    assert.deepEqual((await pool.query('SELECT * FROM layer_settings WHERE user_id=$1',[account.id])).rows[0],saved);
    for (const opacity of [-.1,1.1,NaN,Infinity,-Infinity]) await assert.rejects(pool.query('UPDATE layer_settings SET opacity=$1 WHERE user_id=$2',[opacity,account.id]), {code:'23514'});
    for (const revision of [0,-1]) await assert.rejects(pool.query('UPDATE layer_settings SET revision=$1 WHERE user_id=$2',[revision,account.id]), {code:'23514'});
    for (const key of ['opacity','revision','created_at','updated_at']) await assert.rejects(pool.query(`UPDATE layer_settings SET ${key}=NULL WHERE user_id=$1`,[account.id]), {code:'23502'});
    await assert.rejects(pool.query("UPDATE layer_settings SET updated_at='infinity' WHERE user_id=$1",[account.id]), {code:'23514'});
    await assert.rejects(pool.query("UPDATE layer_settings SET updated_at='1970-01-01' WHERE user_id=$1",[account.id]), {code:'23514'});
  });
});

test('deleting an owner removes its images/bytes/settings while preserving another owner', async () => {
  await isolatedSchema(async pool => {
    await applyMigrations(pool);
    const a = await user(pool), b = await user(pool);
    const ai = await image(pool,a.id), bi = await image(pool,b.id); // Same names and bytes are valid.
    await pool.query('INSERT INTO layer_settings(user_id) VALUES($1),($2)',[a.id,b.id]);
    await pool.query('DELETE FROM users WHERE id=$1',[a.id]);
    assert.equal((await pool.query('SELECT file_data FROM images WHERE id=$1',[ai])).rows.length,0);
    assert.equal((await pool.query('SELECT * FROM layer_settings WHERE user_id=$1',[a.id])).rows.length,0);
    assert.equal((await pool.query('SELECT file_data FROM images WHERE id=$1',[bi])).rows[0].file_data.equals(png),true);
    assert.equal((await pool.query('SELECT * FROM layer_settings WHERE user_id=$1',[b.id])).rows.length,1);
  });
});
