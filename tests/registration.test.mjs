import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHook } from 'node:async_hooks';
import { createRegistrationHandler } from '../src/backend/registration.mjs';
import { verifyPassword } from '../src/backend/passwords.mjs';
import { ApiError } from '../src/backend/http-errors.mjs';

const password = 'P09 public fixture password';
const body = { email: ' ALICE@EXAMPLE.TEST ', password, name: ' <b>Алиса</b> ' };
const user = { id: 'server-user', email: 'alice@example.test', name: '<b>Алиса</b>' };
function fixture({ duplicate = false, fail, failRollback = false, badProfile = false, badCookie = false, emitError = false } = {}) {
  const operations = [], releases = [];
  let committed = false;
  const client = new EventEmitter();
  client.query = async (sql, values) => {
    const type = sql.includes('INSERT INTO users') ? 'user' : sql.includes('INSERT INTO layer_settings') ? 'settings' : sql;
    operations.push({ type, values });
    if (type === fail || (type === 'ROLLBACK' && failRollback)) throw new Error('SELECT TOP_SECRET postgresql://u:password@db');
    if (type === 'COMMIT') committed = true;
    return { rows: type === 'user' && !duplicate ? [{ ...user, name: badProfile ? null : user.name }] : [] };
  };
  client.release = destroy => { releases.push(destroy); };
  const database = { pool: { async connect() { operations.push({ type: 'connect' }); return client; } } };
  const sessions = { async issue(userId, options) {
    operations.push({ type: 'session', userId, options });
    if (emitError) { client.emit('error', new Error('TOP_SECRET')); throw new Error('TOP_SECRET'); }
    if (fail === 'session') throw new ApiError('DATABASE_UNAVAILABLE');
    return { cookie: badCookie ? 'TOP_SECRET\nINJECTED' : 'am_session=TOKEN_ONLY_IN_COOKIE; HttpOnly; Path=/' };
  } };
  return { handler: createRegistrationHandler({ database, sessions }), operations, releases, client, committed: () => committed };
}

test('invalid registration fields fail before hashing or obtaining a database connection', async () => {
  let connected = false;
  let hashOperations = 0;
  const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') hashOperations++; } });
  const handler = createRegistrationHandler({ database: { pool: { connect() { connected = true; throw new Error('Do not connect'); } } }, sessions: {} });
  hook.enable();
  try {
    for (const invalid of [null, {}, { ...body, password: 'SHORT' }, { ...body, email: 'INVALID' }, { ...body, name: '\u0000' }, { ...body, userId: 'forged' }]) {
      await assert.rejects(handler({ body: invalid }), { code: 'VALIDATION_ERROR' });
    }
  } finally { hook.disable(); }
  assert.equal(connected, false);
  assert.equal(hashOperations, 0);
});

test('registration uses one client for user/settings/session and returns a safe 201 only after COMMIT', async () => {
  const f = fixture();
  const response = await f.handler({ body, auth: { session: { id: 'previous-session' } } });
  assert.equal(f.committed(), true);
  assert.deepEqual(f.operations.map(operation => operation.type), ['connect', 'BEGIN', 'user', 'settings', 'session', 'COMMIT']);
  const inserted = f.operations.find(operation => operation.type === 'user').values;
  assert.equal(inserted[0], user.email);
  assert.equal(inserted[1], user.name);
  assert.match(inserted[2], /^scrypt\$v=1\$/);
  assert.ok(!JSON.stringify(inserted).includes(password));
  assert.equal(await verifyPassword(password, inserted[2]), true);
  assert.deepEqual(f.operations.find(operation => operation.type === 'settings').values, [user.id]);
  const session = f.operations.find(operation => operation.type === 'session');
  assert.equal(session.userId, user.id);
  assert.equal(session.options.client, f.client);
  assert.equal(session.options.replaceSessionId, 'previous-session');
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /^am_session=/);
  assert.deepEqual(await response.json(), { user });
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('database email conflict rolls back without creating settings/session or issuing a cookie', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(f.handler({ body }), { code: 'EMAIL_EXISTS', status: 409 });
  assert.deepEqual(f.operations.map(operation => operation.type), ['connect', 'BEGIN', 'user', 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.committed(), false);
});

test('connection failure is a safe 503 without driver details', async () => {
  const handler = createRegistrationHandler({ database: { pool: { async connect() { throw new Error('postgresql://u:TOP_SECRET@host/db'); } } }, sessions: {} });
  await assert.rejects(handler({ body }), error => {
    assert.equal(error.code, 'DATABASE_UNAVAILABLE');
    assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|postgresql/);
    return true;
  });
});

test('settings and session failures roll back and safely release the transaction client', async () => {
  for (const fail of ['settings', 'session']) {
    const f = fixture({ fail });
    await assert.rejects(f.handler({ body }), error => {
      assert.equal(error.code, 'DATABASE_UNAVAILABLE');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|SELECT|postgresql/);
      return true;
    });
    assert.equal(f.operations.at(-1).type, 'ROLLBACK');
    assert.deepEqual(f.releases, [false]);
    assert.equal(f.committed(), false);
  }
});

test('failed BEGIN/COMMIT acknowledgements and failed rollback discard the connection', async () => {
  for (const options of [{ fail: 'BEGIN' }, { fail: 'COMMIT' }, { duplicate: true, failRollback: true }]) {
    const f = fixture(options);
    await assert.rejects(f.handler({ body }), { code: options.duplicate ? 'EMAIL_EXISTS' : 'DATABASE_UNAVAILABLE' });
    assert.deepEqual(f.releases, [true]);
    assert.equal(f.committed(), false);
    assert.equal(f.client.listenerCount('error'), 0);
  }
});

test('checked-out connection errors are handled and the broken client is destroyed', async () => {
  const f = fixture({ emitError: true });
  await assert.rejects(f.handler({ body }), { code: 'DATABASE_UNAVAILABLE' });
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.committed(), false);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('profile/cookie response construction failure rolls back before COMMIT', async () => {
  for (const options of [{ badProfile: true }, { badCookie: true }]) {
    const f = fixture(options);
    await assert.rejects(f.handler({ body }), { code: 'INTERNAL_ERROR' });
    assert.equal(f.operations.at(-1).type, 'ROLLBACK');
    assert.deepEqual(f.releases, [false]);
    assert.equal(f.committed(), false);
  }
});
