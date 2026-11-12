// Real Node/PostgreSQL auth. Only explicitly named fault cases replace a response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const baseURL = process.env.P14_BASE_URL || 'http://127.0.0.1:3000';
const artifacts = process.env.P14_ARTIFACT_DIR;
const phase = (page, value) => page.waitForFunction(expected => document.documentElement.dataset.accountPhase === expected, value);
const storage = page => page.evaluate(() => ({
  local: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])),
  session: Object.fromEntries(Object.keys(sessionStorage).sort().map(key => [key, sessionStorage.getItem(key)])),
}));
const credentials = { password: '  😀😀😀😀😀😀😀😀😀😀😀😀  ', name: '<img src=x onerror=alert(1)>' };

test('P14: real cookie authentication on ordinary Node/PostgreSQL', { timeout: 180_000 }, async t => {
  const databaseURL = process.env.P14_TEST_DATABASE_URL;
  assert.ok(databaseURL, 'Set P14_TEST_DATABASE_URL to an isolated database whose name ends in _test.');
  const url = new URL(databaseURL);
  assert.ok(decodeURIComponent(url.pathname).endsWith('_test'), 'Refusing browser fixture writes outside a _test database.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'These fixtures require local PostgreSQL.');
  const pool = new pg.Pool({ connectionString: databaseURL, ssl: false, max: 2 });
  const ownedEmails = [];
  let browser;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  try {
    // Before registration, prove that the HTTP server uses this exact disposable
    // DB. A short-lived probe session is removed with only its own user.
    const email = `p14-probe-${randomUUID()}@example.test`;
    ownedEmails.push(email);
    const { rows: [probe] } = await pool.query('INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id', [email, 'P14 probe', 'not-a-login-hash']);
    const token = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,CURRENT_TIMESTAMP+INTERVAL '5 minutes')", [probe.id, createHash('sha256').update(token).digest()]);
    const check = await fetch(new URL('/api/auth/me', baseURL), { headers: { Cookie: `am_session=${token}` }, cache: 'no-store' });
    assert.equal(check.status, 200);
    assert.equal((await check.json()).user?.id, probe.id, 'The server must use the same isolated test database.');
    await pool.query('DELETE FROM users WHERE id=$1', [probe.id]);

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    async function scenario(label, width, touch, run) {
      await t.test(label, async () => {
        const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: touch, isMobile: touch });
        const page = await context.newPage();
        page.setDefaultTimeout(12_000);
        const errors = [], alerts = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', async dialog => { alerts.push(dialog.type()); await dialog.dismiss(); });
        for (const [file, contentType] of [['leaflet.js', 'text/javascript'], ['leaflet.css', 'text/css']]) {
          await page.route(`https://unpkg.com/leaflet@1.9.4/dist/${file}`, route => route.fulfill({
            path: fileURLToPath(new URL(`../../node_modules/leaflet/dist/${file}`, import.meta.url)), contentType,
          }));
        }
        const activate = locator => touch ? locator.tap() : locator.click();
        const open = async () => { await activate(page.locator('#accountBtn')); await page.locator('#accountDialog[open]').waitFor(); };
        const login = async data => {
          await open();
          await page.locator('#loginEmail').fill(data.email);
          await page.locator('#loginPassword').fill(data.password);
          await activate(page.locator('#accountLoginForm button[type="submit"]'));
        };
        try {
          await run({ page, context, activate, open, login });
          assert.deepEqual(errors, []);
          assert.deepEqual(alerts, []);
        } catch (error) {
          if (artifacts) {
            await page.screenshot({ path: resolve(artifacts, `${label}-failed.png`) }).catch(() => {});
            await writeFile(resolve(artifacts, `${label}-failed.json`), JSON.stringify({ message: error.message, errors }, null, 2));
          }
          throw error;
        } finally { await context.close(); }
      });
    }
    let known;
    for (const [width, touch] of [[1363, false], [320, true], [375, true]]) {
      await scenario(`lifecycle-${width}`, width, touch, async ({ page, context, activate, open, login }) => {
        const data = { ...credentials, ...(width === 320 ? { name: '😀'.repeat(80) } : {}), email: `p14-ui-${randomUUID()}@example.test` };
        ownedEmails.push(data.email); known ??= data;
        await page.goto(baseURL); await phase(page, 'guest');
        await page.evaluate(() => { localStorage.setItem('p14-sentinel', 'local'); sessionStorage.setItem('p14-sentinel', 'session'); });
        const before = await storage(page);
        const originalURL = page.url();
        let registerCalls = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/api/auth/register', async route => {
          registerCalls++;
          const response = await route.fetch();
          await gate;
          await route.fulfill({ response });
        });
        await open(); await activate(page.locator('#accountRegisterTab'));
        for (const [id, value] of [['registerEmail', data.email], ['registerPassword', data.password], ['registerName', data.name]]) await page.locator(`#${id}`).fill(value);
        assert.equal(await page.locator('#accountNameText').textContent(), data.name);
        assert.equal(await page.locator('#accountNameText > *').count(), 0);
        await activate(page.locator('#accountRegisterForm button[type="submit"]'));
        await phase(page, 'loading');
        assert.equal(await page.locator('#imageFile').isDisabled(), true);
        assert.equal(await page.locator('#accountRegisterTab').isDisabled(), true);
        await page.locator('#accountRegisterForm').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
        assert.equal(registerCalls, 1);
        if (!touch) {
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('#accountDialog').open
            && [...document.querySelectorAll('#accountDialog input')].every(input => input.value === ''));
        }
        release(); await phase(page, 'authenticated');
        await page.unroute('**/api/auth/register');
        assert.equal(await page.locator('#accountName').textContent(), data.name);
        assert.equal(await page.locator('#accountName > *').count(), 0);
        assert.equal(await page.locator('#logoutBtn').isVisible(), true);
        assert.equal(await page.locator('#accountDialog').getAttribute('open'), null);
        const cookie = (await context.cookies(baseURL)).find(item => item.name === 'am_session');
        assert.ok(cookie?.httpOnly);
        assert.equal(cookie.sameSite, 'Lax');
        assert.equal(await page.evaluate(() => document.cookie.includes('am_session')), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.deepEqual(await storage(page), before);
        if (artifacts) await page.screenshot({ path: resolve(artifacts, `authenticated-${width}.png`) });
        await page.reload(); await phase(page, 'authenticated');
        assert.equal(await page.locator('#accountName').textContent(), data.name);
        await page.locator('#imageFile').setInputFiles({ name: 'p14-guard.jpg', mimeType: 'image/jpeg', buffer: await readFile(new URL('../../src/genplan.jpg', import.meta.url)) });
        await page.locator('#drawingList .drawing-row').waitFor();
        let finishLogout;
        const logoutGate = new Promise(resolve => { finishLogout = resolve; });
        await page.route('**/api/auth/logout', async route => { const response = await route.fetch(); await logoutGate; await route.fulfill({ response }); });
        await activate(page.locator('#logoutBtn')); await phase(page, 'loading');
        assert.equal(await page.locator('#imageFile').isDisabled(), true);
        assert.ok(await page.locator('.drawing-row input, .drawing-row button').evaluateAll(controls => controls.every(control => control.disabled)));
        assert.equal(await page.locator('.image-handle.leaflet-marker-draggable, .image-move.leaflet-marker-draggable').count(), 0);
        finishLogout(); await phase(page, 'guest');
        await page.unroute('**/api/auth/logout');
        assert.equal((await context.cookies(baseURL)).some(item => item.name === 'am_session'), false);
        await page.reload(); await phase(page, 'guest');
        await login({ ...data, password: 'wrong password' });
        await page.locator('#accountLoginForm [role="status"]').filter({ hasText: /Неверн/ }).waitFor();
        assert.equal(await page.locator('#loginPassword').inputValue(), '');
        await page.locator('#loginPassword').fill(data.password);
        await activate(page.locator('#accountLoginForm button[type="submit"]')); await phase(page, 'authenticated');
        await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
        await open(); await activate(page.locator('#accountRegisterTab'));
        for (const [id, value] of [['registerEmail', data.email], ['registerPassword', data.password], ['registerName', 'Повтор']]) await page.locator(`#${id}`).fill(value);
        await activate(page.locator('#accountRegisterForm button[type="submit"]'));
        await page.waitForFunction(() => document.querySelector('#registerEmail').getAttribute('aria-invalid') === 'true');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'registerEmail');
        assert.equal(await page.locator('#registerPassword').inputValue(), '');
        assert.equal(page.url(), originalURL);
        assert.deepEqual(await storage(page), before);
        if (artifacts) await page.screenshot({ path: resolve(artifacts, `lifecycle-${width}.png`) });
      });
    }

    await scenario('session-failure-and-retry', 1363, false, async ({ page, open, activate }) => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/auth/me', async route => { await gate; await route.fulfill({ status: 503, json: { error: { code: 'DATABASE_UNAVAILABLE', message: 'База данных временно недоступна.' } } }); });
      await page.goto(baseURL); await phase(page, 'loading');
      assert.equal(await page.locator('#imageFile').isDisabled(), true);
      assert.equal(await page.locator('#accountBtn').isDisabled(), true);
      release(); await phase(page, 'error');
      assert.equal(await page.locator('#imageFile').isDisabled(), true);
      const scale = await page.locator('.leaflet-control-scale-line').first().textContent();
      await page.locator('.leaflet-control-zoom-in').click();
      await page.waitForFunction(previous => document.querySelector('.leaflet-control-scale-line').textContent !== previous, scale);
      await open();
      assert.match(await page.locator('#accountNotice').textContent(), /недоступна/);
      assert.equal(await page.locator('#loginEmail').isDisabled(), true);
      await page.unroute('**/api/auth/me');
      await activate(page.locator('#accountRetry')); await phase(page, 'guest');
      assert.equal(await page.locator('#imageFile').isDisabled(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'loginEmail');
    });

    await scenario('login-outage-rate-limit-and-retry', 1363, false, async ({ page, activate, login }) => {
      await page.goto(baseURL); await phase(page, 'guest');
      const before = await storage(page);
      await page.route('**/api/auth/login', route => route.abort('connectionfailed'));
      await login(known); await phase(page, 'error');
      assert.equal(await page.locator('#loginPassword').inputValue(), '');
      assert.equal(await page.locator('#imageFile').isDisabled(), true);
      await page.unroute('**/api/auth/login');
      await activate(page.locator('#accountRetry')); await phase(page, 'guest');
      await page.route('**/api/auth/login', route => route.fulfill({ status: 429, headers: { 'Retry-After': '7' }, json: { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток.' } } }));
      await page.locator('#loginPassword').fill(known.password);
      await activate(page.locator('#accountLoginForm button[type="submit"]'));
      await page.locator('#accountLoginForm [role="status"]').filter({ hasText: '7 с.' }).waitFor();
      assert.equal(await page.locator('#accountName').isVisible(), false);
      await page.unroute('**/api/auth/login');
      await page.locator('#loginPassword').fill(known.password);
      await activate(page.locator('#accountLoginForm button[type="submit"]')); await phase(page, 'authenticated');
      await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, json: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Выход не подтверждён.' } } }));
      await activate(page.locator('#logoutBtn')); await phase(page, 'error');
      await page.unroute('**/api/auth/logout');
      await activate(page.locator('#accountRetry')); await phase(page, 'authenticated');
      await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
      assert.deepEqual(await storage(page), before);
    });

    await scenario('committed-mutations-with-lost-responses', 375, true, async ({ page, activate, login }) => {
      await page.goto(baseURL); await phase(page, 'guest');
      const before = await storage(page);
      await page.route('**/api/auth/login', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: 'invalid JSON after Set-Cookie' });
      });
      await login(known); await phase(page, 'error');
      await page.unroute('**/api/auth/login');
      await activate(page.locator('#accountRetry')); await phase(page, 'authenticated');
      await page.route('**/api/auth/logout', async route => { await route.fetch(); await route.abort('connectionfailed'); });
      await activate(page.locator('#logoutBtn')); await phase(page, 'error');
      await page.unroute('**/api/auth/logout');
      await activate(page.locator('#accountRetry')); await phase(page, 'guest');
      assert.equal(await page.locator('#accountName').isVisible(), false);
      assert.deepEqual(await storage(page), before);
    });
  } finally {
    await browser?.close();
    await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [ownedEmails]);
    await pool.end();
  }
});
