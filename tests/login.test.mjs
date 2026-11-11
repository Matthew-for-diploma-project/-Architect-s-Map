import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHook } from 'node:async_hooks';
import { createLoginHandler } from '../src/backend/login.mjs';
import { hashPassword } from '../src/backend/passwords.mjs';
import { ApiError, apiErrorResponse } from '../src/backend/http-errors.mjs';

const password = '  P10 public e\u0301 password 🔑  ';
const body = { email: ' ALICE@EXAMPLE.TEST ', password };
const user = { id: 'server-user', email: 'alice@example.test', name: 'Текущее имя' };
let passwordHash;
before(async () => { passwordHash = await hashPassword(password); });

function fixture({ missing = false, malformed = false, changed = false, failLookup = false, failConnect = false, failSession = false, badCookie = false } = {}) {
  const operations = [], releases = [];
  let committed = false;
  const client = new EventEmitter();
  client.query = async (sql, values) => {
    const type = sql.includes('FOR SHARE') ? 'recheck' : sql;
    operations.push({ type, sql, values });
    if (type === 'COMMIT') committed = true;
    return { rows: type === 'recheck' && !changed ? [user] : [] };
  };
  client.release = destroy => { releases.push(destroy); };
  const database = { pool: {
    async query(sql, values) {
      operations.push({ type: 'lookup', sql, values });
      if (failLookup) throw new Error('SELECT TOP_SECRET postgresql://user:password@db');
      return { rows: missing ? [] : [{ ...user, name: 'Старое имя', password_hash: malformed ? 'TOP_SECRET_BAD_HASH' : passwordHash }] };
    },
    async connect() {
      operations.push({ type: 'connect' });
      if (failConnect) throw new Error('postgresql://user:TOP_SECRET@db');
      return client;
    },
  } };
  const sessions = { async issue(userId, options) {
    operations.push({ type: 'session', userId, options });
    if (failSession) throw new ApiError('DATABASE_UNAVAILABLE');
    return { cookie: badCookie ? 'TOP_SECRET\nINJECTED' : 'am_session=TOKEN_ONLY_IN_COOKIE; HttpOnly; Path=/' };
  } };
  return { handler: createLoginHandler({ database, sessions }), operations, releases, client, committed: () => committed };
}

async function countScrypt(run) {
  let operations = 0;
  const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
  hook.enable();
  try { await run(); } finally { hook.disable(); }
  return operations;
}

test('invalid login fields fail before database access or password work', async () => {
  const f = fixture();
  const operations = await countScrypt(async () => {
    for (const invalid of [null, {}, { ...body, password: 'SHORT' }, { ...body, email: 'bad' }, { ...body, name: 'extra' }, { ...body, userId: 'forged' }]) {
      await assert.rejects(f.handler({ body: invalid }), { code: 'VALIDATION_ERROR' });
    }
  });
  assert.equal(operations, 0);
  assert.deepEqual(f.operations, []);
});

test('login normalizes email, rechecks the verified snapshot and returns safe 200/cookie only after COMMIT', async () => {
  const f = fixture();
  const response = await f.handler({ body, auth: { session: { id: 'previous-session' } } });
  assert.equal(f.committed(), true);
  assert.deepEqual(f.operations.map(operation => operation.type), ['lookup', 'connect', 'BEGIN', 'recheck', 'session', 'COMMIT']);
  assert.deepEqual(f.operations[0].values, [user.email]);
  assert.deepEqual(f.operations.find(operation => operation.type === 'recheck').values, [user.id, passwordHash]);
  const session = f.operations.find(operation => operation.type === 'session');
  assert.equal(session.userId, user.id);
  assert.equal(session.options.client, f.client);
  assert.equal(session.options.replaceSessionId, 'previous-session');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^am_session=/);
  const value = await response.json();
  assert.deepEqual(value, { user });
  for (const secret of [password, passwordHash, 'TOKEN_ONLY_IN_COOKIE', 'previous-session']) assert.ok(!JSON.stringify(value).includes(secret));
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('wrong, unknown and malformed-hash accounts give identical 401 and one real async scrypt without session changes', async () => {
  const responses = [];
  for (const [options, candidate] of [[{}, { ...body, password: 'Wrong P10 public password' }], [{ missing: true }, body], [{ malformed: true }, body]]) {
    const f = fixture(options);
    let error;
    const operations = await countScrypt(async () => {
      try { await f.handler({ body: candidate, auth: { user, session: { id: 'existing-session' } } }); }
      catch (caught) { error = caught; }
    });
    assert.equal(operations, 1);
    assert.equal(error.code, 'INVALID_CREDENTIALS');
    const response = apiErrorResponse(error);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    responses.push(await response.text());
    assert.deepEqual(f.operations.map(operation => operation.type), ['lookup']);
    assert.deepEqual(f.releases, []);
  }
  assert.equal(new Set(responses).size, 1);
  assert.doesNotMatch(responses[0], /TOP_SECRET|password_hash|SELECT|server-user/);
});

test('login passes the exact password without trimming, changing case or Unicode normalization', async () => {
  for (const candidate of [password.trim(), password.toUpperCase(), password.normalize('NFC')]) {
    const f = fixture();
    await assert.rejects(f.handler({ body: { ...body, password: candidate } }), { code: 'INVALID_CREDENTIALS' });
    assert.deepEqual(f.operations.map(operation => operation.type), ['lookup']);
  }
});

test('database lookup/connection failures are safe 503 and never masquerade as bad credentials', async () => {
  for (const options of [{ failLookup: true }, { failConnect: true }]) {
    const f = fixture(options);
    await assert.rejects(f.handler({ body }), error => {
      assert.equal(error.code, 'DATABASE_UNAVAILABLE');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET|SELECT|postgresql/);
      return true;
    });
    assert.deepEqual(f.releases, []);
    assert.ok(!f.operations.some(operation => operation.type === 'session'));
  }
});

test('a removed or changed account after verification rolls back without a session or cookie', async () => {
  const f = fixture({ changed: true });
  await assert.rejects(f.handler({ body }), { code: 'INVALID_CREDENTIALS' });
  assert.deepEqual(f.operations.map(operation => operation.type), ['lookup', 'connect', 'BEGIN', 'recheck', 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.committed(), false);
});

test('session/response preparation errors roll back instead of committing or issuing cookies', async () => {
  for (const options of [{ failSession: true }, { badCookie: true }]) {
    const f = fixture(options);
    await assert.rejects(f.handler({ body }), { code: options.failSession ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR' });
    assert.equal(f.operations.at(-1).type, 'ROLLBACK');
    assert.deepEqual(f.releases, [false]);
    assert.equal(f.committed(), false);
  }
});
