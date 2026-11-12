import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountFieldError } from '../src/account-dialog.mjs';
import { validateRegistration, validateLogin } from '../src/backend/account-validation.mjs';

const account = { email: 'reader@example.ru', password: 'twelve chars', name: 'Анна' };

for (const [field, values] of Object.entries({
  email: ['  USER@EXAMPLE.RU  ', 'имя@пример.рф', 'a@b.c', 'a@b', 'a@@b.c', 'a@.b.c', 'a@b.c.', 'a b@c.d',
    'a\u0000@b.c', 'a\ud800@b.c', 'я'.repeat(250) + '@b.c', 'я'.repeat(251) + '@b.c', 'İ'.repeat(130) + '@b.c', ''],
  password: [' '.repeat(12), '😀'.repeat(12), '😀'.repeat(128), '😀'.repeat(129), 'a'.repeat(11), 'a'.repeat(12),
    'a'.repeat(128), 'a'.repeat(129), '  unchanged  ', 'e\u0301'.repeat(6), 'a'.repeat(12) + '\ud800', ''],
  name: [' Анна ', '<img src=x onerror=alert(1)>', '😀'.repeat(80), '😀'.repeat(81), 'я'.repeat(80),
    'я'.repeat(81), 'a\u0000b', '\ud800', ' ', ''],
})) {
  test(`dialog ${field} policy agrees with the account API, including Unicode boundaries`, () => {
    for (const value of values) {
      for (const validate of field === 'name' ? [validateRegistration] : [validateRegistration, validateLogin]) {
        const data = { ...account, [field]: value };
        if (validate === validateLogin) delete data.name;
        let serverError = false;
        try { validate(data); } catch (error) { serverError = Boolean(error.fields?.[field]); }
        assert.equal(Boolean(accountFieldError(field, value)), serverError, `${field}: ${JSON.stringify(value)}`);
      }
    }
  });
}

test('built Worker serves the exact account module and its client import', async () => {
  const worker = (await import('../dist/server/index.js')).default;
  const response = await worker.fetch(new Request('https://test/account-dialog.js'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), await readFile(new URL('../src/account-dialog.mjs', import.meta.url), 'utf8'));
  const app = await (await worker.fetch(new Request('https://test/app.js'))).text();
  assert.match(app, /import \{ initAccountDialog \} from '.\/account-dialog.js'/);
  assert.ok(app.indexOf('initAccountDialog();') < app.indexOf('L.map('));
  assert.equal((await worker.fetch(new Request('https://test/account-dialog.mjs'))).status, 404);
});
