// Controlled map/auth fixtures isolate drawing composition from live providers.
// Real Node/PostgreSQL sessions and guest gates remain in account-api.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.P16_BASE_URL || 'http://127.0.0.1:3000';
const artifacts = process.env.P16_ARTIFACT_DIR;
const range = (locator, value) => locator.evaluate((input, value) => {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const near = (actual, expected, message, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≈ ${expected}`);

test('P16: drawing order, per-image composition and editor regression', { timeout: 180_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  if (artifacts) await mkdir(artifacts, { recursive: true });
  try {
    for (const [width, touch] of [[1363, false], [375, true]]) {
      await t.test(`${width}px ${touch ? 'touch' : 'mouse'}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
        const page = await context.newPage();
        page.setDefaultTimeout(12_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const colors = await page.evaluate(() => Object.fromEntries(['red', 'blue', 'lime'].map(color => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 100, 100);
          return [color, canvas.toDataURL()];
        })));
        const png = color => Buffer.from(colors[color].split(',')[1], 'base64');
        const leafletJS = await readFile(new URL('../../node_modules/leaflet/dist/leaflet.js', import.meta.url), 'utf8');
        // Expose the real map to add adversarial data overlays to every default
        // pane and to exercise the public LayerGroup remove/re-add lifecycle.
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'unpkg.com' && url.pathname.endsWith('/leaflet.js')) return route.fulfill({
            contentType: 'text/javascript', body: leafletJS + '\nL.Map.addInitHook(function () { window.p16Map = this; });',
          });
          if (url.hostname === 'unpkg.com' && url.pathname.endsWith('/leaflet.css')) return route.fulfill({
            contentType: 'text/css', path: new URL('../../node_modules/leaflet/dist/leaflet.css', import.meta.url).pathname,
          });
          if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: {
            id: '16a00000-0000-4000-8000-000000000001', email: 'p16-ui@example.test', name: 'Drawing fixture',
          } } });
          if (url.pathname === '/api/auth/logout') return route.fulfill({ status: 204 });
          if (url.pathname.startsWith('/api/cadastre/')) return route.fulfill({ json: { features: [{ type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[39.5, 54.4], [40, 54.4], [40, 54.9], [39.5, 54.9], [39.5, 54.4]]] },
            properties: { 'Кадастровый номер': '62:29:0040006:531', 'Адрес': 'P16 fixture' },
          }] } });
          if (url.hostname === 'cogisdemo.dataeast.com' && url.pathname.endsWith('/query')) return route.fulfill({ json: { features: [] } });
          if (url.origin !== new URL(baseURL).origin || url.pathname === '/genplan.jpg') return route.fulfill({ contentType: 'image/png', body: png('lime') });
          return route.continue();
        });
        const image = index => page.locator('.leaflet-drawings-pane img').nth(index);
        const row = index => page.locator('.drawing-row').nth(index);
        const global = page.locator('#drawingOpacity');
        async function opacities(expected) {
          const values = await page.locator('.leaflet-drawings-pane img').evaluateAll(images => images.map(img => Number(getComputedStyle(img).opacity)));
          assert.equal(values.length, expected.length);
          values.forEach((value, i) => near(value, expected[i], `image ${i}`));
          assert.equal(await page.locator('.leaflet-drawings-pane').evaluate(el => getComputedStyle(el).opacity), '1');
        }
        async function sidebar(open) {
          if (await page.locator('#toggleSidebar').getAttribute('aria-expanded') !== String(open)) await page.locator('#toggleSidebar').click();
          await page.waitForFunction(() => !document.querySelector('.leaflet-map-pane').classList.contains('leaflet-zoom-anim'));
          // invalidateSize runs after the panel transition.
          await page.waitForTimeout(220);
        }
        async function sample() {
          const box = await image(0).boundingBox();
          const screenshot = await page.screenshot({ animations: 'disabled', clip: { x: Math.round(box.x + box.width * .25), y: Math.round(box.y + box.height * .25), width: 1, height: 1 } });
          return page.evaluate(async data => {
            const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); return [...ctx.getImageData(0, 0, 1, 1).data];
          }, screenshot.toString('base64'));
        }
        const rgb = async (expected, label) => (await sample()).slice(0, 3).forEach((value, i) => near(value, expected[i], `${label}, channel ${i}`, 3));
        try {
          await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => document.documentElement.dataset.accountPhase === 'authenticated');
          await page.locator('.leaflet-genplan-pane img').waitFor();
          await page.locator('#parcelStatus.ready').waitFor();
          // Exercise the application's real identify/highlight rendering path.
          await page.evaluate(() => p16Map.fire('click', { latlng: p16Map.getCenter() }));
          await page.locator('.leaflet-parcelHighlight-pane canvas').waitFor();
          await page.locator('#inspector .cad').filter({ hasText: '62:29:0040006:531' }).waitFor();
          await page.locator('#toggleDetails').click();
          await sidebar(true);
          await range(global, .5); // Empty group retains the chosen setting.
          await page.locator('#imageFile').setInputFiles(['red', 'blue'].map(color => ({ name: `${color}.png`, mimeType: 'image/png', buffer: png(color) })));
          await page.waitForFunction(() => document.querySelectorAll('.drawing-row').length === 2);
          await opacities([.325, .325]);
          await range(row(0).locator('.drawing-opacity'), .8);
          await range(row(1).locator('.drawing-opacity'), .4);
          await opacities([.4, .2]);
          await sidebar(false);

          const panes = await page.evaluate(green => {
            const map = p16Map;
            const dataPanes = Object.entries(map.getPanes()).filter(([id]) => !['mapPane', 'drawings', 'drawingHandles'].includes(id));
            for (const [pane] of dataPanes) L.imageOverlay(green, map.getBounds().pad(3), { pane, interactive: false }).addTo(map);
            map.eachLayer(layer => {
              if (layer instanceof L.LayerGroup && layer.getLayers().some(child => child instanceof L.ImageOverlay && child.options.pane === 'drawings')) window.p16Group = layer;
            });
            return { data: dataPanes.map(([id, el]) => ({ id, z: Number(getComputedStyle(el).zIndex) })),
              drawings: Number(getComputedStyle(map.getPane('drawings')).zIndex), handles: Number(getComputedStyle(map.getPane('drawingHandles')).zIndex) };
          }, colors.lime);
          for (const { id, z } of panes.data) assert.ok(panes.drawings > z, `drawings above ${id}`);
          assert.ok(panes.handles > panes.drawings);
          await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-image-layer')].every(img => img.complete));
          // Expected source-over result: blue(.4*.5) over red(.8*.5) over green.
          // Parent opacity would produce approximately [61,143,51] and fail.
          await rgb([82, 122, 51], 'per-image alpha product');
          await range(global, 0); await opacities([0, 0]); await rgb([0, 255, 0], 'global zero');
          assert.equal(await page.locator('.leaflet-drawingHandles-pane .leaflet-marker-icon').count(), 10);
          assert.ok(await page.locator('.leaflet-drawingHandles-pane .leaflet-marker-icon').evaluateAll(markers => markers.every(marker => getComputedStyle(marker).opacity === '1')));
          await range(row(0).locator('.drawing-opacity'), 1);
          await range(row(1).locator('.drawing-opacity'), 0);
          await opacities([0, 0]);
          await range(global, 1); await opacities([1, 0]); await rgb([255, 0, 0], 'restore individual values');
          await range(row(1).locator('.drawing-opacity'), 1); await opacities([1, 1]); await rgb([0, 0, 255], 'top drawing above all data panes');
          await range(global, .5); await opacities([.5, .5]);
          await range(row(0).locator('.drawing-opacity'), .8);
          await range(row(1).locator('.drawing-opacity'), .4);
          await opacities([.4, .2]); await rgb([82, 122, 51], 'independent regulators');
          await page.locator('#imageFile').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: png('blue') });
          await page.waitForFunction(() => document.querySelectorAll('.drawing-row').length === 3);
          await opacities([.4, .2, .325]); // New uploads inherit the global value.
          await sidebar(true); await row(2).locator('.remove').click(); await sidebar(false);
          await opacities([.4, .2]);

          assert.ok(await page.evaluate(() => !!window.p16Group), 'drawings/editors have one group');
          await page.evaluate(() => p16Map.removeLayer(p16Group));
          assert.equal(await page.locator('.leaflet-drawings-pane img, .leaflet-drawingHandles-pane .leaflet-marker-icon').count(), 0);
          await page.evaluate(() => p16Group.addTo(p16Map));
          await opacities([.4, .2]);
          assert.equal(await page.locator('.leaflet-drawingHandles-pane .leaflet-marker-icon').count(), 10);
          const zoom = await page.evaluate(() => p16Map.getZoom());
          // The panel toggle shares the zoom button's corner in the existing UI.
          // Focus/keyboard activation still verifies the real Leaflet control.
          await page.locator('.leaflet-control-zoom-in').focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(value => p16Map.getZoom() === value + 1, zoom);
          await page.waitForFunction(() => !document.querySelector('.leaflet-map-pane').classList.contains('leaflet-zoom-anim'));
          await page.locator('.leaflet-control-zoom-out').focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(value => p16Map.getZoom() === value, zoom);
          await page.waitForFunction(() => !document.querySelector('.leaflet-map-pane').classList.contains('leaflet-zoom-anim'));
          const center = await page.evaluate(() => p16Map.getCenter().lng);
          await page.locator('#map').focus(); await page.keyboard.press('ArrowRight');
          await page.waitForFunction(value => p16Map.getCenter().lng !== value, center);
          await page.waitForFunction(() => !p16Map._panAnim?._inProgress);
          await opacities([.4, .2]);

          const handle = page.locator('.image-move').last();
          const box = await handle.boundingBox();
          assert.ok(await handle.evaluate(el => { const b = el.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el; }), 'editor receives pointer above every drawing');
          const beforeMove = await image(1).boundingBox();
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          if (touch) {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 25 * step / 6, y: y + 20 * step / 6 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
          } else {
            await page.mouse.move(x, y); await page.mouse.down();
            await page.mouse.move(x + 25, y + 20, { steps: 6 }); await page.mouse.up();
          }
          assert.ok(Math.abs((await image(1).boundingBox()).x - beforeMove.x) > 10, 'move through editor pane');
          await sidebar(true);
          // Switching data layers must leave drawings, editors and alpha intact.
          await page.getByLabel('Спутник', { exact: true }).check();
          await page.getByLabel('Спутник', { exact: true }).uncheck();
          await page.locator('#genplanToggle').click(); await page.locator('#genplanToggle').click();
          await page.locator('#parcelToggle').uncheck(); await page.locator('#parcelToggle').check();
          await opacities([.4, .2]);
          await range(row(1).locator('.drawing-angle'), 37);
          assert.match(await image(1).evaluate(el => el.style.transform), /rotate\(37deg\)/);
          await row(1).locator('.lock').click();
          assert.equal(await page.locator('.image-handle, .image-move').count(), 5);
          await row(1).locator('.lock').click();
          assert.equal(await page.locator('.image-handle, .image-move').count(), 10);
          await row(1).locator('.locate').click();
          await opacities([.4, .2]);
          if (artifacts) await page.screenshot({ path: resolve(artifacts, `${width}-drawings.png`) });
          await sidebar(true);
          await row(1).locator('.remove').click(); await row(0).locator('.remove').click();
          assert.equal(await page.locator('.leaflet-drawings-pane img, .image-handle, .image-move').count(), 0);
          assert.equal(await page.evaluate(() => p16Group.getLayers().length), 0, 'deletion removes group children');
          await range(global, .25);
          await page.locator('#imageFile').setInputFiles({ name: 'after-empty.png', mimeType: 'image/png', buffer: png('red') });
          await page.waitForFunction(() => document.querySelectorAll('.drawing-row').length === 1);
          await opacities([.1625]);
          // Native modal/top bar must remain reachable over the raised panes.
          await page.locator('#logoutBtn').click();
          await page.waitForFunction(() => document.documentElement.dataset.accountPhase === 'guest');
          await page.locator('#addDrawing').click(); await page.locator('#accountDialog[open]').waitFor();
          await page.locator('#closeAccount').click(); await page.waitForFunction(() => !document.querySelector('#accountDialog').open);
          await opacities([.1625]);
          assert.deepEqual(errors, []);
        } catch (error) {
          if (artifacts) {
            await page.screenshot({ path: resolve(artifacts, `${width}-failed.png`) }).catch(() => {});
            await writeFile(resolve(artifacts, `${width}-failed.json`), JSON.stringify({ error: error.message, errors }, null, 2));
          }
          throw error;
        } finally { await context.close(); }
      });
    }
  } finally { await browser.close(); }
});
