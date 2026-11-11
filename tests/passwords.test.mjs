import test from 'node:test';
import assert from 'node:assert/strict';
import { scrypt } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { promisify } from 'node:util';
import { hashPassword, verifyPassword } from '../src/backend/passwords.mjs';

const derive = promisify(scrypt);
const password = 'P07 public fixture password 🔑';

test('password hash stores a version, bounded scrypt parameters, random salt and independently verified key', async () => {
  const encoded = await hashPassword(password);
  const [algorithm, version, parameters, saltText, keyText] = encoded.split('$');
  assert.equal(algorithm, 'scrypt');
  assert.equal(version, 'v=1');
  assert.equal(parameters, 'N=131072,r=8,p=1,dkLen=32');
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  assert.equal(salt.length, 16);
  assert.equal(key.length, 32);
  assert.equal(salt.toString('base64url'), saltText);
  assert.equal(key.toString('base64url'), keyText);
  assert.ok(encoded.length < 2048);
  assert.ok(!encoded.includes(password));
  const independent = await derive(Buffer.from(password, 'utf8'), salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.deepEqual(key, independent);
});

test('identical passwords receive different salts and both stored hashes remain verifiable', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.notEqual(first.split('$')[3], second.split('$')[3]);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
});

test('verification requires the exact password without trimming, case-folding or Unicode normalization', async () => {
  const original = '  Пароль-секрет e\u0301 🔑  ';
  const encoded = await hashPassword(original);
  assert.equal(await verifyPassword(original, encoded), true);
  assert.equal(await verifyPassword(original.trim(), encoded), false);
  assert.equal(await verifyPassword(original.toUpperCase(), encoded), false);
  assert.equal(await verifyPassword(original.normalize('NFC'), encoded), false);
});

test('known, wrong, unknown and malformed records each run one real asynchronous scrypt', async () => {
  const encoded = await hashPassword(password);
  const parts = encoded.split('$');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Set an unused pad bit: a permissive base64 decoder produces the SAME bytes.
  // A verifier that merely decodes these alternate strings would accept them.
  const noncanonical = text => text.slice(0, -1) + alphabet[alphabet.indexOf(text.at(-1)) + 1];
  const badSaltText = noncanonical(parts[3]);
  const badKeyText = noncanonical(parts[4]);
  assert.deepEqual(Buffer.from(badSaltText, 'base64url'), Buffer.from(parts[3], 'base64url'));
  assert.deepEqual(Buffer.from(badKeyText, 'base64url'), Buffer.from(parts[4], 'base64url'));
  const corruptSalt = parts.slice(0, 3).join('$') + '$' + badSaltText + '$' + parts[4];
  const corruptKey = parts.slice(0, 4).join('$') + '$' + badKeyText;
  const cases = [
    [password, encoded, true], ['wrong P07 fixture password', encoded, false],
    ...[null, undefined, {}, '', 'TOP_SECRET_NOT_A_HASH', encoded + '$extra',
      encoded.replace('v=1', 'v=2'), encoded.replace('N=131072', 'N=1024'),
      encoded.replace('N=131072', 'N=999999999999'), encoded.replace('r=8', 'r=0'),
      encoded.replace('p=1', 'p=0'), encoded.replace('dkLen=32', 'dkLen=1024'),
      corruptSalt, corruptKey].map(record => [password, record, false]),
  ];
  for (const [candidate, record, expected] of cases) {
    let operations = 0;
    const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
    hook.enable();
    try { assert.equal(await verifyPassword(candidate, record), expected); }
    finally { hook.disable(); }
    assert.equal(operations, 1, 'every valid candidate needs one async scrypt even without a usable record');
  }
});

test('invalid passwords fail before expensive work and errors never contain their input', async () => {
  const candidates = ['', 'TOP_SECRET', 'TOP_SECRET'.repeat(20), null, {}, '12345678901\ud800'];
  let operations = 0;
  const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') operations++; } });
  hook.enable();
  try {
    for (const candidate of candidates) {
      for (const operation of [hashPassword, input => verifyPassword(input, null)]) {
        await assert.rejects(operation(candidate), error => {
          assert.equal(error.code, 'VALIDATION_ERROR');
          assert.equal(typeof error.fields.password, 'string');
          assert.doesNotMatch(error.stack + JSON.stringify(error), /TOP_SECRET/);
          return true;
        });
      }
    }
  } finally { hook.disable(); }
  assert.equal(operations, 0);
});
