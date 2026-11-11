import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateRegistration, validateLogin, validatePassword, toPublicUser } from '../src/backend/account-validation.mjs';
import { ApiError, apiErrorResponse } from '../src/backend/http-errors.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';

const password = 'P07 test password'; // A public fixture, not a credential.
const valid = { email: 'alice@example.test', password, name: 'Алиса' };
function invalid(run, field) {
  assert.throws(run, error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.equal(typeof error.fields[field], 'string');
    return true;
  });
}

test('registration and login share email normalization without mutating credentials', () => {
  for (const [input, expected] of [
    ['  ALICE@EXAMPLE.TEST \n', 'alice@example.test'],
    [' Пользователь@ПРИМЕР.ТЕСТ ', 'пользователь@пример.тест'],
    ['İ@Example.Test', 'i\u0307@example.test'],
  ]) {
    const body = Object.freeze({ ...valid, email: input, name: '\u00a0 Алиса \u00a0' });
    const registration = validateRegistration(body);
    const login = validateLogin({ email: input, password });
    assert.deepEqual(registration, { ...valid, email: expected });
    assert.deepEqual(login, { email: expected, password });
    assert.equal(body.email, input);
    assert.equal(body.name, '\u00a0 Алиса \u00a0');
  }
});

test('email format checks normalized code-point length, domain, separators and control characters', () => {
  for (const email of ['a@b.c', 'e'.repeat(250) + '@b.c', '😀'.repeat(250) + '@b.c']) {
    assert.equal(validateRegistration({ ...valid, email }).email, email);
  }
  for (const email of [undefined, null, 123, {}, '', '  ', 'a', 'a@b', '@a.test', 'a@', 'a@@b.test',
    'a@.test', 'a@example.', 'a b@example.test', 'a@exam\tple.test', 'a@exam\u00a0ple.test',
    'a\u0000@example.test', 'a\u0085@example.test', '\ud800@example.test', 'e'.repeat(251) + '@b.c']) {
    invalid(() => validateRegistration({ ...valid, email }), 'email');
    invalid(() => validateLogin({ email, password }), 'email');
  }
});

test('password policy counts 12–128 Unicode code points and preserves spaces, case, NUL and normalization', () => {
  const samples = ['x'.repeat(12), 'x'.repeat(128), '😀'.repeat(12), '😀'.repeat(128), ' '.repeat(12),
    '12345678901\u0000', ' e\u0301 PaRoLь 🔑 ', 'é'.repeat(12), 'e\u0301'.repeat(6)];
  for (const candidate of samples) {
    assert.equal(validatePassword(candidate), undefined);
    assert.equal(validateRegistration({ ...valid, password: candidate }).password, candidate);
    assert.equal(validateLogin({ email: valid.email, password: candidate }).password, candidate);
  }
  for (const candidate of [undefined, null, 123, {}, Buffer.alloc(12), '', 'x'.repeat(11), 'x'.repeat(129),
    '😀'.repeat(11), '😀'.repeat(129), '12345678901\ud800', '12345678901\udc00']) {
    invalid(() => validatePassword(candidate), 'password');
    invalid(() => validateRegistration({ ...valid, password: candidate }), 'password');
    invalid(() => validateLogin({ email: valid.email, password: candidate }), 'password');
  }
});

test('display names are trimmed text with a code-point limit and no control characters', () => {
  for (const name of ['Я', '😀'.repeat(80), 'Имя с пробелом', '<img src=x onerror=alert(1)>', 'О’Коннор <архитектор>']) {
    assert.equal(validateRegistration({ ...valid, name: '  ' + name + '  ' }).name, name);
  }
  for (const name of [undefined, null, 123, {}, '', '  \n\t ', '😀'.repeat(81), 'я'.repeat(81),
    'Имя\nФамилия', 'Имя\tФамилия', 'Имя\u0000', 'Имя\u001b', 'Имя\u007f', 'Имя\u0085', 'Имя\ud800']) {
    invalid(() => validateRegistration({ ...valid, name }), 'name');
  }
});

test('account objects reject missing, unknown and inherited fields without prototype pollution', () => {
  for (const body of [undefined, null, [], 'text', 123, new Date(), Object.create(valid)]) {
    invalid(() => validateRegistration(body), '_form');
    invalid(() => validateLogin(body), '_form');
  }
  for (const field of ['email', 'password', 'name']) {
    const body = { ...valid };
    delete body[field];
    invalid(() => validateRegistration(body), field);
  }
  invalid(() => validateLogin({ email: valid.email }), 'password');
  invalid(() => validateLogin({ password }), 'email');
  invalid(() => validateLogin(valid), '_form'); // name is not a login field.
  for (const key of ['id', 'userId', 'password_hash', 'constructor', 'SECRET_FIELD']) {
    invalid(() => validateRegistration({ ...valid, [key]: 'untrusted' }), '_form');
  }
  const polluted = JSON.parse('{"email":"alice@example.test","password":"P07 test password","name":"Алиса","__proto__":{"p07_polluted":true}}');
  invalid(() => validateRegistration(polluted), '_form');
  assert.equal({}.p07_polluted, undefined);
  assert.deepEqual(validateRegistration(Object.assign(Object.create(null), valid)), valid);
});

test('validation errors contain fixed field messages and never submitted values', async () => {
  const secret = 'TOP_SECRET_INPUT';
  let error;
  try { validateRegistration({ email: secret, password: secret.repeat(10), name: '\u0000' + secret, [secret]: secret }); }
  catch (caught) { error = caught; }
  assert.deepEqual(Object.keys(error.fields).sort(), ['_form', 'email', 'name', 'password']);
  assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET_INPUT/);
  const response = apiErrorResponse(error);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await response.text(), /TOP_SECRET_INPUT/);
});

test('public profile copies only id/email/name and keeps markup as text without private fields', () => {
  const row = { id: 'server-uuid', ...valid, name: '<script>alert(1)</script>', password_hash: 'PRIVATE_HASH', salt: 'PRIVATE_SALT',
    token_hash: Buffer.from('PRIVATE_TOKEN'), created_at: new Date(), user_id: 'PRIVATE_OWNER' };
  const profile = toPublicUser(row);
  assert.deepEqual(profile, { id: row.id, email: row.email, name: row.name });
  assert.notEqual(profile, row);
  assert.doesNotMatch(JSON.stringify(profile), /PRIVATE_|password|salt|token|user_id/);
  for (const broken of [null, {}, { ...row, name: {} }, { ...row, id: undefined }]) {
    assert.throws(() => toPublicUser(broken), { code: 'INTERNAL_ERROR' });
  }
});

test('account helpers fit Node API errors and safe JSON profiles without implementing auth routes', async () => {
  const handle = createNodeApiHandler({ handlers: { 'auth.register': context => {
    const account = validateRegistration(context.body);
    return Response.json({ user: toPublicUser({ id: 'server-uuid', ...account, password_hash: 'PRIVATE_HASH' }) });
  } } });
  const send = body => {
    const incoming = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(incoming, { method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json' } });
    return handle(incoming);
  };
  const response = await send({ ...valid, name: '<b>Алиса</b>' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const value = await response.json();
  assert.deepEqual(value, { user: { id: 'server-uuid', email: valid.email, name: '<b>Алиса</b>' } });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|P07 test password|password/);
  const invalidResponse = await send({ ...valid, password: 'TOO_SHORT' });
  assert.equal(invalidResponse.status, 400);
  const invalidValue = await invalidResponse.json();
  assert.equal(invalidValue.error.code, 'VALIDATION_ERROR');
  assert.equal(typeof invalidValue.error.fields.password, 'string');
  assert.doesNotMatch(JSON.stringify(invalidValue), /TOO_SHORT/);
});
