// Dialog UI regression with controlled account errors. Real Node/PostgreSQL auth is tested in account-api.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseURL = process.env.P13_BASE_URL || 'http://127.0.0.1:3000';
const artifacts = process.env.P13_ARTIFACT_DIR;
const viewports = [
  { width: 1363, height: 900, touch: false },
  { width: 320, height: 850, touch: true },
  { width: 375, height: 850, touch: true },
  { width: 390, height: 850, touch: true },
  { width: 375, height: 320, touch: true },
  { width: 320, height: 240, touch: true },
];

test('P13–P15: account UI and guest personal controls', { timeout: 240_000 }, async t => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  if (artifacts) await mkdir(artifacts, { recursive: true });
  try {
    for (const { width, height, touch } of viewports) {
      await t.test(`${width}x${height}, ${touch ? 'touch' : 'mouse and keyboard'}`, async () => {
        const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
        const page = await context.newPage();
        const submitted = [];
        let authorizeDrawingFixture = false;
        await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
        for (const operation of ['login', 'register']) {
          await page.route(`**/api/auth/${operation}`, route => {
            submitted.push(route.request().postDataJSON());
            if (operation === 'login' && authorizeDrawingFixture) return route.fulfill({ json: { user: {
              id: '15a00000-0000-4000-8000-000000000001', email: 'p15-ui@example.test', name: 'UI fixture',
            } } });
            return route.fulfill({ status: operation === 'login' ? 401 : 409, json: { error: {
              code: operation === 'login' ? 'INVALID_CREDENTIALS' : 'EMAIL_EXISTS',
              message: operation === 'login' ? 'Неверная почта или пароль.' : 'Почта уже используется.',
              ...(operation === 'register' ? { fields: { email: 'Почта уже используется.' } } : {}),
            } } });
          });
        }
        // The same pinned Leaflet release as index.html, without CDN availability
        // becoming a prerequisite for this controlled UI regression.
        for (const [file, contentType] of [['leaflet.js', 'text/javascript'], ['leaflet.css', 'text/css']]) {
          await page.route(`https://unpkg.com/leaflet@1.9.4/dist/${file}`, route => route.fulfill({
            path: fileURLToPath(new URL(`../../node_modules/leaflet/dist/${file}`, import.meta.url)), contentType,
          }));
        }
        page.setDefaultTimeout(10_000);
        const authRequests = [], pageErrors = [], alerts = [], failedRequests = [];
        let fileChoosers = 0;
        page.on('filechooser', () => fileChoosers++);
        page.on('request', request => {
          if (new URL(request.url()).pathname.startsWith('/api/auth')) authRequests.push(request.url());
        });
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
        page.on('dialog', async dialog => { alerts.push(dialog.type()); await dialog.dismiss(); });
        const activate = locator => touch ? locator.tap() : locator.click();
        const storage = () => page.evaluate(() => {
          const entries = store => Object.keys(store).sort().map(key => [key, store.getItem(key)]);
          return { local: entries(localStorage), session: entries(sessionStorage) };
        });
        const focus = () => page.evaluate(() => document.activeElement.id);
        try {
          await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
          await page.locator('#accountBtn:not([disabled])').waitFor();
          await page.locator('.leaflet-control-zoom-in').waitFor();
          const originalURL = page.url();
          // Nonempty stores also catch destructive clearing, not just new writes.
          await page.evaluate(() => {
            localStorage.setItem('p13-acceptance-sentinel', 'preserve-local');
            sessionStorage.setItem('p13-acceptance-sentinel', 'preserve-session');
            window.p13Pointers = [];
            document.addEventListener('pointerdown', event => {
              if (event.target.closest('[role="tab"], #addDrawing, #drawingOpacityGuest')) {
                window.p13Pointers.push({ type: event.pointerType, trusted: event.isTrusted });
              }
            });
          });
          const baseline = await storage();
          const unchanged = async stage => assert.deepEqual(await storage(), baseline, `Web Storage: ${stage}`);
          const dialog = page.locator('#accountDialog');
          const login = page.locator('#accountLoginTab'), register = page.locator('#accountRegisterTab');
          const selected = async id => {
            assert.equal(await page.locator('[role="tab"][aria-selected="true"]').count(), 1);
            assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id'), id);
          };
          // Both guest entry points stay present with an empty list. Native
          // buttons cover pointer/Enter/Space; range keys must also open auth.
          // On narrow screens the existing details panel overlays the sidebar.
          if (width <= 1050) await activate(page.locator('#toggleDetails'));
          const guestOpacity = await page.locator('.leaflet-drawings-pane').evaluate(element => element.style.opacity);
          const guestUnchanged = async () => {
            assert.equal(await page.locator('#imageFile').isDisabled(), true);
            assert.equal(await page.locator('#imageFile').inputValue(), '');
            assert.equal(await page.locator('#drawingOpacity').inputValue(), '1');
            assert.equal(await page.locator('.leaflet-drawings-pane').evaluate(element => element.style.opacity), guestOpacity);
            assert.equal(await page.locator('#drawingList .drawing-row').count(), 0);
            assert.equal(fileChoosers, 0);
            await unchanged('guest personal controls');
          };
          const guestOpens = async action => {
            await action();
            await page.locator('#accountDialog[open]').waitFor();
            assert.equal(await focus(), 'loginEmail');
            await activate(register);
            assert.equal(await dialog.locator('input:visible').count(), 3);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('#accountDialog').open
              && [...document.querySelectorAll('#accountDialog input')].every(input => input.value === ''));
            await guestUnchanged();
          };
          assert.match(await page.locator('#personalAccess').textContent(), /Войдите или зарегистрируйтесь/);
          for (const id of ['addDrawing', 'drawingOpacityGuest']) {
            const control = page.locator(`#${id}`);
            assert.equal(await control.isVisible(), true);
            assert.match(await control.getAttribute('class'), /personal-locked/);
            await guestOpens(() => activate(control));
            for (const key of ['Enter', 'Space']) await guestOpens(() => control.press(key));
          }
          for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
            await guestOpens(() => page.locator('#drawingOpacityGuest').press(key));
          }
          await guestOpens(async () => page.locator('#imageFile').setInputFiles({
            name: 'p15-guest.jpg', mimeType: 'image/jpeg', buffer: await readFile(new URL('../../src/genplan.jpg', import.meta.url)),
          }));
          for (const type of ['input', 'change']) await guestOpens(() => page.locator('#drawingOpacity').evaluate((element, type) => {
            element.value = '.2'; element.dispatchEvent(new Event(type, { bubbles: true }));
          }, type));
          if (touch) assert.ok((await page.evaluate(() => window.p13Pointers)).filter(e => e.type === 'touch' && e.trusted).length >= 2);
          if (artifacts) {
            await page.locator('#drawingOpacityGuest').scrollIntoViewIfNeeded();
            await page.screenshot({ path: resolve(artifacts, `guest-controls-${width}x${height}.png`) });
          }
          if (width <= 1050) await activate(page.locator('#toggleDetails'));
          await activate(page.locator('#accountBtn'));
          assert.equal(await focus(), 'loginEmail');
          assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
          assert.equal(await dialog.locator('input:visible').count(), 2);
          for (const [id, autocomplete] of Object.entries({
            loginEmail: 'username', loginPassword: 'current-password', registerEmail: 'username',
            registerPassword: 'new-password', registerName: 'nickname',
          })) {
            assert.equal(await page.locator(`#${id}`).getAttribute('autocomplete'), autocomplete);
            assert.ok(await page.locator(`label[for="${id}"]`).textContent());
          }
          assert.equal(await page.locator('#loginPassword').getAttribute('type'), 'password');
          assert.equal(await page.locator('#registerPassword').getAttribute('type'), 'password');
          await page.locator('#loginEmail').fill('имя@пример.рф');
          await page.locator('#loginPassword').fill('😀'.repeat(12));
          await unchanged('login input');
          await activate(register);
          await selected('accountRegisterTab');
          assert.equal(await dialog.locator('input:visible').count(), 3);
          assert.equal(await page.locator('#registerEmail').inputValue(), 'имя@пример.рф');
          assert.equal(await page.locator('#loginPassword').inputValue(), '');
          await page.locator('#registerPassword').fill('twelve chars');
          await activate(login);
          assert.equal(await page.locator('#registerPassword').inputValue(), '');
          await unchanged('switch tabs');
          if (touch) assert.ok((await page.evaluate(() => window.p13Pointers)).filter(e => e.type === 'touch' && e.trusted).length >= 2);

          await login.focus();
          for (const [key, id] of [['ArrowRight', 'accountRegisterTab'], ['Home', 'accountLoginTab'],
            ['End', 'accountRegisterTab'], ['ArrowLeft', 'accountLoginTab']]) {
            await page.keyboard.press(key); await selected(id); assert.equal(await focus(), id);
          }
          for (const tab of [login, register]) {
            await activate(tab);
            for (const key of ['Tab', 'Shift+Tab']) {
              for (let step = 0; step < 12; step++) {
                await page.keyboard.press(key);
                assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
                assert.equal(await page.evaluate(() => document.activeElement.closest('[role="tabpanel"]')?.hidden || false), false);
              }
            }
          }
          await page.locator('#aboutBtn').focus();
          assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
          await page.locator('#map').focus();
          assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('#accountDialog').open && document.activeElement.id === 'accountBtn');
          await unchanged('Escape');
          await activate(page.locator('#accountBtn'));
          assert.equal(await focus(), 'loginEmail');
          await selected('accountLoginTab');
          assert.deepEqual(await dialog.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '', '', '', '']);

          const submitLogin = page.locator('#accountLoginForm button[type="submit"]');
          await activate(submitLogin);
          assert.equal(await focus(), 'loginEmail');
          assert.equal(await page.locator('#loginEmail').getAttribute('aria-invalid'), 'true');
          assert.ok(await page.locator('#loginEmailError').textContent());
          await page.locator('#loginEmail').fill('invalid');
          await page.locator('#loginPassword').fill('a'.repeat(11));
          await activate(submitLogin);
          assert.equal(await page.locator('#loginPassword').getAttribute('aria-invalid'), 'true');
          await page.locator('#loginEmail').fill('имя@пример.рф');
          for (const password of ['a'.repeat(12), '😀'.repeat(12), '😀'.repeat(128), ' '.repeat(12), 'e\u0301'.repeat(6), '  unchanged  ']) {
            await page.locator('#loginPassword').fill(password);
            await activate(submitLogin);
            await page.locator('#accountLoginForm [role="status"]').filter({ hasText: 'Неверная почта или пароль.' }).waitFor();
            assert.equal(submitted.at(-1).password, password);
            assert.equal(await page.locator('#loginPassword').inputValue(), '');
            assert.equal(await page.locator('#loginPassword').getAttribute('aria-invalid'), null);
            assert.match(await page.locator('#accountLoginForm [role="status"]').textContent(), /Неверная почта или пароль/);
            await unchanged('login submit');
          }
          await page.locator('#loginPassword').fill('😀'.repeat(129));
          await activate(submitLogin);
          assert.equal(await focus(), 'loginPassword');
          assert.equal(await page.locator('#loginPassword').getAttribute('aria-invalid'), 'true');

          await activate(register);
          const submitRegister = page.locator('#accountRegisterForm button[type="submit"]');
          await page.locator('#registerPassword').fill('😀'.repeat(12));
          await activate(submitRegister);
          assert.equal(await focus(), 'registerName');
          for (const name of ['😀'.repeat(80), '<img src=x onerror=alert(1)>']) {
            await page.locator('#registerName').fill(name);
            await page.locator('#registerPassword').fill('😀'.repeat(12));
            assert.equal(await page.locator('#accountNameText').textContent(), name);
            assert.equal(await page.locator('#accountNameText > *').count(), 0);
            await unchanged('register input');
            await activate(submitRegister);
            await page.locator('#accountRegisterForm [role="status"]').filter({ hasText: 'Почта уже используется.' }).waitFor();
            assert.equal(await dialog.locator('img').count(), 0);
            await unchanged('register submit');
          }
          await page.locator('#registerName').fill('😀'.repeat(81));
          await activate(submitRegister);
          assert.equal(await page.locator('#registerName').getAttribute('aria-invalid'), 'true');
          const dimensions = await dialog.evaluate(element => ({
            pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
            clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
          }));
          assert.equal(dimensions.pageWidth, width);
          assert.equal(dimensions.viewport, width);
          assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1);
          await submitRegister.scrollIntoViewIfNeeded();
          const buttonBox = await submitRegister.boundingBox();
          assert.ok(buttonBox.y >= 0 && buttonBox.y + buttonBox.height <= height);
          if (artifacts) {
            await page.screenshot({ path: resolve(artifacts, `${width}x${height}.png`) });
            await writeFile(resolve(artifacts, `${width}x${height}.json`), JSON.stringify({ dimensions, touchEvents: await page.evaluate(() => window.p13Pointers) }, null, 2));
          }
          await activate(page.locator('#closeAccount'));
          // Native dialog queues its close event; wait for that handler's reset,
          // rather than observing the synchronous removal of the open attribute.
          await page.waitForFunction(() => !document.querySelector('#accountDialog').open
            && document.activeElement.id === 'accountBtn'
            && [...document.querySelectorAll('#accountDialog input')].every(input => input.value === ''));
          assert.deepEqual(await dialog.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '', '', '', '']);
          assert.equal(await page.locator('#accountNameText').textContent(), '');
          assert.equal(await page.locator('#accountNamePreview').isVisible(), false);
          assert.equal(await dialog.locator('[aria-invalid]').count(), 0);
          assert.equal((await dialog.locator('form [role="status"]').allTextContents()).join(''), '');
          await unchanged('close and clear');
          assert.equal(page.url(), originalURL);
          assert.equal(authRequests.length, 9);
          assert.equal(submitted.length, 8);
          assert.deepEqual(alerts, []);
          assert.deepEqual(pageErrors, []);

          // Map regression after dismissing the native modal.
          await page.locator('#toggleSidebar').click();
          await page.locator('#toggleDetails').click();
          const zoom = page.locator('.leaflet-control-zoom-in');
          const scale = page.locator('.leaflet-control-scale-line').first();
          const initialScale = await scale.textContent();
          await zoom.click();
          await page.waitForFunction(previous => document.querySelector('.leaflet-control-scale-line').textContent !== previous, initialScale);
          await page.locator('.leaflet-control-zoom-out').click();
          const mapPane = page.locator('.leaflet-map-pane');
          const transform = await mapPane.evaluate(element => element.style.transform);
          await page.locator('#map').focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(previous => document.querySelector('.leaflet-map-pane').style.transform !== previous, transform);
          await page.locator('#toggleSidebar').click();
          const baseCount = await page.locator('.leaflet-tile-pane > .leaflet-layer').count();
          await page.getByLabel('Спутник', { exact: true }).check();
          assert.equal(await page.locator('.leaflet-tile-pane > .leaflet-layer').count(), baseCount + 1);
          await page.getByLabel('Спутник', { exact: true }).uncheck();
          assert.equal(await page.locator('.leaflet-tile-pane > .leaflet-layer').count(), baseCount);
          await page.locator('#genplanToggle').click();
          assert.equal(await page.locator('#genplanToggle').getAttribute('aria-checked'), 'false');
          await page.locator('#genplanToggle').click();
          assert.equal(await page.locator('#genplanToggle').getAttribute('aria-checked'), 'true');
          const opacity = page.locator('#genplanOpacity');
          await opacity.press('Home');
          await opacity.press('ArrowRight');
          assert.equal(await page.locator('.leaflet-genplan-pane img').evaluate(element => element.style.opacity), '0.05');
          if (!touch) {
            // This suite deliberately supplies a successful UI auth fixture.
            // Real cookies/DB and the same controls are checked in account-api.
            authorizeDrawingFixture = true;
            await activate(page.locator('#accountBtn'));
            await page.locator('#loginEmail').fill('p15-ui@example.test');
            await page.locator('#loginPassword').fill('p15-ui-password');
            await activate(page.locator('#accountLoginForm button[type="submit"]'));
            await page.waitForFunction(() => document.documentElement.dataset.accountPhase === 'authenticated');
            assert.equal(await page.locator('#imageFile').isDisabled(), false);
            assert.equal(await page.locator('#drawingOpacity').isVisible(), true);
            assert.equal(await page.locator('#drawingList .drawing-row').count(), 0);
            await page.locator('#drawingOpacity').press('Home');
            await page.locator('#drawingOpacity').press('ArrowRight');
            assert.equal(await page.locator('.leaflet-drawings-pane').evaluate(element => element.style.opacity), '0.05');
            await page.locator('#drawingOpacity').press('End');
            await page.locator('#imageFile').setInputFiles({
              name: 'p13-acceptance.jpg', mimeType: 'image/jpeg',
              buffer: await readFile(new URL('../../src/genplan.jpg', import.meta.url)),
            });
            const row = page.locator('#drawingList .drawing-row');
            await row.waitFor();
            const image = page.locator('.leaflet-drawings-pane img');
            const drag = async (handle, dx, dy) => {
              const box = await handle.boundingBox();
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
              await page.mouse.up();
            };
            const initialBox = await image.boundingBox();
            await drag(page.locator('.image-move'), 30, 20);
            assert.ok(Math.abs((await image.boundingBox()).x - initialBox.x) > 10);
            const movedWidth = (await image.boundingBox()).width;
            await drag(page.locator('.image-handle').first(), -20, -10);
            assert.ok(Math.abs((await image.boundingBox()).width - movedWidth) > 10);
            await row.locator('.drawing-angle').press('Home');
            await row.locator('.drawing-angle').press('ArrowRight');
            assert.match(await image.evaluate(element => element.style.transform), /rotate\(-179deg\)/);
            await row.locator('.drawing-opacity').press('Home');
            await row.locator('.drawing-opacity').press('ArrowRight');
            assert.equal(await image.evaluate(element => element.style.opacity), '0.05');
            await row.locator('.lock').click();
            assert.equal(await page.locator('.image-handle, .image-move').count(), 0);
            await row.locator('.lock').click();
            assert.equal(await page.locator('.image-handle').count(), 4);
            await row.locator('.locate').click();
            await row.locator('.remove').click();
            assert.equal(await row.count(), 0);
            assert.equal(await image.count(), 0);
          }
          await page.locator('#toggleDetails').click();
          await page.locator('#toggleDetails').click();
          // The existing About button is hidden by the map's mobile layout.
          if (width <= 720) await page.setViewportSize({ width: 900, height: 850 });
          await page.locator('#aboutBtn').click();
          assert.equal(await page.locator('#drawer').evaluate(element => element.classList.contains('open')), true);
          await page.locator('#closeDrawer').click();
          assert.equal(await page.locator('#drawer').evaluate(element => element.classList.contains('open')), false);
          await unchanged('map regression');
          assert.equal(authRequests.length, touch ? 9 : 10);
          assert.equal(submitted.length, touch ? 8 : 9);
          assert.deepEqual(pageErrors, []);
        } catch (error) {
          if (artifacts) {
            await page.screenshot({ path: resolve(artifacts, `${width}x${height}-failed.png`) }).catch(() => {});
            await writeFile(resolve(artifacts, `${width}x${height}-failed.json`), JSON.stringify({ error: error.message, pageErrors, failedRequests }, null, 2));
          }
          throw error;
        } finally { await context.close(); }
      });
    }
  } finally { await browser.close(); }
});
