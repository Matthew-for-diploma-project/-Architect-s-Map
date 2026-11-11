import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { readDatabaseConfig, DatabaseConfigError } from '../src/backend/database-config.mjs';
import { createDatabase, DatabaseUnavailableError } from '../src/backend/database.mjs';

const run = promisify(execFile);
const working = 'postgresql://map_user:example_password@127.0.0.1:55432/geokontekst';
const testing = 'postgresql://map_test:example_test_password@127.0.0.1:55433/geokontekst_test';
const env = { DATABASE_URL: working, DATABASE_SSL: 'disable' };

test('database configuration is explicit and has bounded pool and timeouts', () => {
  const config = readDatabaseConfig(env);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 55432);
  assert.equal(config.database, 'geokontekst');
  assert.equal(config.max, 5);
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.statement_timeout, 10000);
  assert.equal(config.ssl, false);
  const ipv6 = readDatabaseConfig({ DATABASE_URL: 'postgresql://u:p%40ss@[::1]/map', DB_POOL_MAX: '20' });
  assert.equal(ipv6.password, 'p@ss');
  assert.equal(ipv6.host, '::1');
  assert.equal(ipv6.port, 5432);
  assert.equal(ipv6.max, 20);
  assert.equal(ipv6.ssl.rejectUnauthorized, true);
});

test('invalid connection settings fail without echoing values or credentials', () => {
  const invalid = [
    {}, { DATABASE_URL: '' }, { DATABASE_URL: 'TOP_SECRET' },
    { DATABASE_URL: 'https://user:TOP_SECRET@host/database' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/' },
    { DATABASE_URL: 'postgresql://user@host/database' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/database?sslmode=no-verify' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/database?statement_timeout=0' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/database#fragment' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/%ZZ' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host/a%2Fb' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host:0/map' },
    { DATABASE_URL: 'postgresql://user:TOP_SECRET@host:65536/map' },
    { DATABASE_URL: working, DATABASE_SSL: 'no-verify' },
    { DATABASE_URL: working, NODE_ENV: 'TOP_SECRET' },
    { ...env, DATABASE_CA_FILE: '/TOP_SECRET' },
    { DATABASE_URL: working, DATABASE_CA_FILE: '/TOP_SECRET/nonexistent-ca' },
  ];
  for (const candidate of invalid) {
    assert.throws(() => readDatabaseConfig(candidate), error => {
      assert.ok(error instanceof DatabaseConfigError);
      assert.doesNotMatch(error.stack, /TOP_SECRET|example_password/);
      return true;
    });
  }
  for (const name of ['DB_POOL_MAX', 'DB_CONNECT_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS']) {
    for (const value of ['', '0', '-1', '1.5', '1e3', ' 5', '2147483648']) {
      assert.throws(() => readDatabaseConfig({ ...env, [name]: value }), DatabaseConfigError);
    }
  }
  assert.throws(() => readDatabaseConfig({ ...env, DB_POOL_MAX: '21' }), DatabaseConfigError);
});

test('test mode never falls back to DATABASE_URL and enforces separate database and role', () => {
  assert.throws(() => readDatabaseConfig({ ...env, NODE_ENV: 'test' }), /TEST_DATABASE_URL/);
  assert.throws(() => readDatabaseConfig({ ...env, NODE_ENV: 'test', TEST_DATABASE_URL: working }), /_test/);
  assert.throws(() => readDatabaseConfig({ ...env, NODE_ENV: 'test', TEST_DATABASE_URL: testing.replace('map_test:', 'map_user:') }), /отдельные/);
  assert.throws(() => readDatabaseConfig({ ...env, NODE_ENV: 'test', DATABASE_URL: testing, TEST_DATABASE_URL: testing }), /отдельные/);
  const config = readDatabaseConfig({ ...env, NODE_ENV: 'test', TEST_DATABASE_URL: testing });
  assert.equal(config.database, 'geokontekst_test');
  assert.equal(config.user, 'map_test');
  assert.equal(config.port, 55433);
});

test('unresponsive database is bounded, errors are safe and closing is idempotent', async () => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const errors = [];
  const database = createDatabase({
    env: { DATABASE_URL: `postgresql://user:TOP_SECRET@127.0.0.1:${server.address().port}/map`, DATABASE_SSL: 'disable', DB_CONNECT_TIMEOUT_MS: '100' },
    onError: error => errors.push(error),
  });
  try {
    await assert.rejects(database.checkConnection(), error => {
      assert.ok(error instanceof DatabaseUnavailableError);
      assert.equal(error.code, 'DATABASE_UNAVAILABLE');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|postgresql:\/\//);
      return true;
    });
    database.pool.emit('error', new Error('TOP_SECRET'));
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0].stack, /TOP_SECRET/);
    const close = database.close();
    assert.equal(close, database.close());
    await close;
    assert.equal(database.pool.totalCount, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await database.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('database CLI and server reject missing configuration without starting HTTP', async () => {
  const cleanEnv = { PATH: process.env.PATH, NODE_ENV: 'development' };
  for (const script of ['tools/check-database.mjs', 'tools/serve.mjs', 'tools/migrate.mjs']) {
    await assert.rejects(run(process.execPath, [script], { env: cleanEnv, timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /DATABASE_URL/);
      assert.doesNotMatch(error.stdout, /ГеоКонтекст: http/);
      return true;
    });
  }
});

test('Worker build excludes Node database modules and environment configuration', () => {
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../dist/server/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(build, /src\/backend|DATABASE_URL|\.env/);
  assert.doesNotMatch(worker, /DATABASE_URL|TEST_DATABASE_URL|DB_POOL_MAX|DATABASE_CA_FILE|from ['"]pg['"]|createNodeApiHandler|readBoundedBody|NOT_IMPLEMENTED|hashPassword|verifyPassword|validateRegistration|toPublicUser|node:crypto|PUBLIC_ORIGIN|SESSION_TTL_SECONDS|createSessionService|createAuthenticationGuard|am_session/);
});
