import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadMigrations, applyMigrations, MigrationError } from '../src/backend/migrations.mjs';

async function temporaryPlan(files, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'geokontekst-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql);
    return await fn(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('migration files are ordered and their checksums detect changes', async () => {
  await temporaryPlan({ '0002_second.sql': 'SELECT 2;\n', '0001_first.sql': 'SELECT 1;\n' }, async directory => {
    const first = await loadMigrations(directory);
    assert.deepEqual(first.map(step => step.version), [1, 2]);
    await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;\r\n');
    const windows = await loadMigrations(directory);
    assert.equal(windows[0].checksum, first[0].checksum);
    assert.equal(windows[0].sql, first[0].sql);
    await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 3;\n');
    const changed = await loadMigrations(directory);
    assert.notEqual(changed[0].checksum, first[0].checksum);
    assert.equal(changed[1].checksum, first[1].checksum);
  });
});

test('invalid or missing migration plans are rejected before any database access', async () => {
  for (const files of [{}, { '0002_gap.sql': 'SELECT 1;' }, { '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' }, { 'bad.sql': 'SELECT 1;' }, { '0001_empty.sql': '  ' }]) {
    await temporaryPlan(files, async directory => {
      const pool = { connect() { assert.fail('Invalid plan must not connect to PostgreSQL'); } };
      await assert.rejects(applyMigrations(pool, { directory }), MigrationError);
    });
  }
  await assert.rejects(loadMigrations('/MIGRATION_TOP_SECRET/missing'), error => {
    assert.ok(error instanceof MigrationError);
    assert.doesNotMatch(error.stack, /MIGRATION_TOP_SECRET/);
    return true;
  });
});

test('migration connection errors never expose driver details', async () => {
  await temporaryPlan({ '0001_test.sql': 'SELECT 1;' }, async directory => {
    const pool = { async connect() { throw new Error('postgresql://u:MIGRATION_TOP_SECRET@host/db'); } };
    await assert.rejects(applyMigrations(pool, { directory }), error => {
      assert.equal(error.code, 'MIGRATION_FAILED');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /MIGRATION_TOP_SECRET|postgresql:\/\//);
      return true;
    });
  });
});

test('migration CLI requires an explicit safe test mode', async () => {
  const run = promisify(execFile);
  for (const [args, mode] of [[['--test'], 'development'], [[], 'test'], [['--unknown'], 'development']]) {
    await assert.rejects(run(process.execPath, ['tools/migrate.mjs', ...args], { env: { PATH: process.env.PATH, NODE_ENV: mode }, timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--test/);
      return true;
    });
  }
});
