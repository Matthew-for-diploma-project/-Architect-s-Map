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
async function personalControls(page, blocked) {
  assert.equal(await page.locator('#addDrawing').isVisible(), true);
  assert.equal(await page.locator('#imageFile').isDisabled(), blocked);
  assert.equal(await page.locator('#drawingOpacity').isDisabled(), blocked);
  assert.equal(await page.locator('#drawingOpacity').isVisible(), !blocked);
  assert.equal(await page.locator('#drawingOpacityGuest').isVisible(), blocked);
}
async function uncoverSidebar(page) {
  if (await page.evaluate(() => innerWidth <= 1050 && !document.querySelector('#workspace').classList.contains('details-collapsed'))) {
    await page.locator('#toggleDetails').click();
  }
}

test('P14/P15: real sessions and access to personal controls', { timeout: 240_000 }, async t => {
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
        await uncoverSidebar(page);
        await personalControls(page, true);
        assert.equal(await page.locator('#drawingList .drawing-row').count(), 0);
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
        // Register directly from the permanently visible guest add control.
        await activate(page.locator('#addDrawing')); await page.locator('#accountDialog[open]').waitFor();
        await activate(page.locator('#accountRegisterTab'));
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
        await personalControls(page, false);
        assert.equal(await page.locator('#drawingList .drawing-row').count(), 0);
        await page.locator('#drawingOpacity').press('Home');
        await page.locator('#drawingOpacity').press('ArrowRight');
        assert.equal(await page.locator('.leaflet-drawings-pane').evaluate(element => element.style.opacity), '0.05');
        await page.locator('#drawingOpacity').press('End');
        const cookie = (await context.cookies(baseURL)).find(item => item.name === 'am_session');
        assert.ok(cookie?.httpOnly);
        assert.equal(cookie.sameSite, 'Lax');
        assert.equal(await page.evaluate(() => document.cookie.includes('am_session')), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.deepEqual(await storage(page), before);
        if (artifacts) await page.screenshot({ path: resolve(artifacts, `authenticated-${width}.png`) });
        await page.reload(); await phase(page, 'authenticated');
        await uncoverSidebar(page);
        await personalControls(page, false);
        assert.equal(await page.locator('#accountName').textContent(), data.name);
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), activate(page.locator('#addDrawing'))]);
        await chooser.setFiles({ name: 'p15-guard.jpg', mimeType: 'image/jpeg', buffer: await readFile(new URL('../../src/genplan.jpg', import.meta.url)) });
        await page.locator('#drawingList .drawing-row').waitFor();
        await page.locator('#drawingOpacity').press('Home');
        for (let step = 0; step < 8; step++) await page.locator('#drawingOpacity').press('ArrowRight');
        const drawingBefore = await page.locator('.leaflet-drawings-pane img').evaluate(element => ({ opacity: element.style.opacity, transform: element.style.transform }));
        let finishLogout;
        const logoutGate = new Promise(resolve => { finishLogout = resolve; });
        await page.route('**/api/auth/logout', async route => { const response = await route.fetch(); await logoutGate; await route.fulfill({ response }); });
        await activate(page.locator('#logoutBtn')); await phase(page, 'loading');
        await personalControls(page, true);
        assert.equal(await page.locator('#imageFile').isDisabled(), true);
        assert.ok(await page.locator('.drawing-row input, .drawing-row button').evaluateAll(controls => controls.every(control => control.disabled)));
        assert.equal(await page.locator('.image-handle.leaflet-marker-draggable, .image-move.leaflet-marker-draggable').count(), 0);
        finishLogout(); await phase(page, 'guest');
        await page.unroute('**/api/auth/logout');
        await personalControls(page, true);
        await page.locator('#drawingOpacity').evaluate(element => { element.value = '.1'; element.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.locator('#accountDialog[open]').waitFor();
        assert.equal(await page.locator('#drawingOpacity').inputValue(), '0.4');
        assert.equal(await page.locator('.leaflet-drawings-pane').evaluate(element => element.style.opacity), '0.4');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#accountDialog').open);
        await page.locator('.drawing-row').evaluate(row => {
          for (const selector of ['.drawing-opacity', '.drawing-angle']) {
            const input = row.querySelector(selector); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          for (const selector of ['.lock', '.remove']) row.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        assert.equal(await page.locator('.drawing-row').count(), 1);
        assert.deepEqual(await page.locator('.leaflet-drawings-pane img').evaluate(element => ({ opacity: element.style.opacity, transform: element.style.transform })), drawingBefore);
        assert.equal(await page.locator('.drawing-row .lock').textContent(), 'Зафиксировать');
        assert.equal((await context.cookies(baseURL)).some(item => item.name === 'am_session'), false);
        await page.reload(); await phase(page, 'guest');
        await login({ ...data, password: 'wrong password' });
        await page.locator('#accountLoginForm [role="status"]').filter({ hasText: /Неверн/ }).waitFor();
        assert.equal(await page.locator('#loginPassword').inputValue(), '');
        await page.locator('#loginPassword').fill(data.password);
        await activate(page.locator('#accountLoginForm button[type="submit"]')); await phase(page, 'authenticated');
        await personalControls(page, false);
        await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
        await personalControls(page, true);
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

    await scenario('decode-cancelled-across-sessions', 1363, false, async ({ page, activate, login }) => {
      await page.goto(baseURL); await phase(page, 'guest');
      await login(known); await phase(page, 'authenticated');
      // Delay the real image's decoded callback, then release it only after
      // logout and another successful login. A phase-only guard would fail.
      await page.evaluate(() => {
        const NativeImage = window.Image, nativeRevoke = URL.revokeObjectURL.bind(URL);
        window.p15Revoked = [];
        URL.revokeObjectURL = url => { window.p15Revoked.push(url); nativeRevoke(url); };
        window.Image = function(...args) {
          const image = new NativeImage(...args);
          let onload;
          Object.defineProperty(image, 'onload', {
            get: () => onload,
            set(callback) {
              onload = callback;
              image.addEventListener('load', () => { window.p15FinishDecode = () => callback.call(image); }, { once: true });
            },
          });
          window.p15DecodeImage = image;
          window.Image = NativeImage;
          return image;
        };
      });
      await page.locator('#imageFile').setInputFiles({ name: 'p15-delayed.jpg', mimeType: 'image/jpeg', buffer: await readFile(new URL('../../src/genplan.jpg', import.meta.url)) });
      await page.waitForFunction(() => typeof window.p15FinishDecode === 'function');
      const pendingURL = await page.evaluate(() => window.p15DecodeImage.src);
      await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
      await login(known); await phase(page, 'authenticated');
      await page.evaluate(() => window.p15FinishDecode());
      await page.locator('#drawingMessage').filter({ hasText: 'состояние аккаунта изменилось' }).waitFor();
      assert.equal(await page.locator('.drawing-row, .leaflet-drawings-pane img, .image-handle, .image-move').count(), 0);
      assert.equal(await page.locator('#imageFile').inputValue(), '');
      assert.ok((await page.evaluate(() => window.p15Revoked)).includes(pendingURL));
      await personalControls(page, false);
      await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
    });

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
      await personalControls(page, true);
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

    for (const [width, touch] of [[1363, false], [320, true]]) {
      await scenario(`logout-origin-rejection-${width}`, width, touch, async ({ page, context, activate, login }) => {
        await page.goto(baseURL); await phase(page, 'guest');
        await login(known); await phase(page, 'authenticated');
        const before = await storage(page);
        const cookieBefore = (await context.cookies(baseURL)).find(item => item.name === 'am_session');
        let logoutCalls = 0;
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/logout') logoutCalls++; });
        await page.route('**/api/auth/logout', async route => {
          // Exercise the real Origin guard while preserving this browser's
          // session. Only the outgoing Origin changes; the 403 comes from Node.
          const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://untrusted.example.test' } });
          assert.equal(response.status(), 403);
          assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
          await route.fulfill({ response });
        });
        await activate(page.locator('#logoutBtn')); await phase(page, 'error');
        await page.locator('#accountDialog[open]').waitFor();
        assert.match(await page.locator('#accountNotice').textContent(), /источник|origin/i);
        assert.equal(await page.locator('#accountRetry').isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'accountRetry');
        assert.equal(await page.locator('#loginEmail').isDisabled(), true);
        assert.equal(await page.locator('#imageFile').isDisabled(), true);
        assert.equal((await context.cookies(baseURL)).find(item => item.name === 'am_session')?.value, cookieBefore.value);
        assert.equal(logoutCalls, 1);
        if (artifacts) await page.screenshot({ path: resolve(artifacts, `logout-origin-rejection-${width}.png`) });
        await page.unroute('**/api/auth/logout');
        await activate(page.locator('#accountRetry')); await phase(page, 'authenticated');
        assert.equal(await page.locator('#accountName').textContent(), known.name);
        assert.equal(await page.locator('#accountDialog').getAttribute('open'), null);
        assert.equal(logoutCalls, 1, 'Checking me must not repeat logout.');
        await activate(page.locator('#logoutBtn')); await phase(page, 'guest');
        assert.equal(logoutCalls, 2);
        assert.equal((await context.cookies(baseURL)).some(item => item.name === 'am_session'), false);
        assert.deepEqual(await storage(page), before);
      });
    }

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
