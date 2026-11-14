import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageMetadata, validateImagePatch, validateImageName, validateImageMimeType } from '../src/backend/image-metadata.mjs';
const bounds = [[54.6, 39.7], [54.7, 39.8]];

test('P18 metadata defaults and exact numeric/boolean boundary values preserve precision', () => {
  assert.deepEqual(validateImageMetadata({ bounds }), { bounds, angle: 0, opacity: .65, locked: false });
  for (const angle of [-180, 0, 180]) for (const opacity of [0, .333333333333, 1]) for (const locked of [false, true]) {
    const value = { bounds: [[-85, -180], [85, 180]], angle, opacity, locked };
    assert.deepEqual(validateImageMetadata(value), value);
  }
  const result = validateImageMetadata({ bounds }); assert.notEqual(result.bounds, bounds);
});

test('P18 invalid WGS84, nonfinite coordinates, reversed bounds and date-line crossings fail', () => {
  for (const value of [null, [], [[0, 0]], [[0, 0], [1, 1, 2]], [[1, 0], [0, 1]], [[0, 1], [1, 0]],
    [[0, 170], [1, -170]], [[-85.1, 0], [1, 1]], [[0, -180.1], [1, 1]], [[0, 0], [85.1, 1]], [[0, 0], [1, 180.1]]]) {
    assert.throws(() => validateImageMetadata({ bounds: value }), { code: 'VALIDATION_ERROR' });
  }
  for (const invalid of [NaN, Infinity, -Infinity, '54.6', null, true]) for (let coordinate = 0; coordinate < 4; coordinate++) {
    const value = structuredClone(bounds); value[Math.floor(coordinate / 2)][coordinate % 2] = invalid;
    assert.throws(() => validateImageMetadata({ bounds: value }), { code: 'VALIDATION_ERROR' });
  }
});

test('P18 parameter shapes/types and untrusted owner/server fields cannot bypass validation', () => {
  for (const input of [null, [], {}, Object.create({ bounds }), { bounds, userId: 'forged' }, { bounds, user_id: 'forged' },
    { bounds, id: 'forged' }, { bounds, width: 1 }, { bounds, angle: 180.1 }, { bounds, angle: -181 },
    { bounds, angle: '0' }, { bounds, opacity: -0.1 }, { bounds, opacity: 1.1 }, { bounds, opacity: NaN },
    { bounds, locked: 1 }, { bounds, locked: 'false' }, { bounds, angle: null }, { bounds, opacity: null }]) {
    assert.throws(() => validateImageMetadata(input), { code: 'VALIDATION_ERROR', status: 400 });
  }
  assert.throws(() => validateImageMetadata(JSON.parse('{"bounds":[[0,0],[1,1]],"__proto__":{}}')), { code: 'VALIDATION_ERROR' });
});

test('P18 patches require revision and a permitted change without resetting omitted settings', () => {
  assert.deepEqual(validateImagePatch({ revision: 1, opacity: 0 }), { revision: 1, opacity: 0 });
  assert.deepEqual(validateImagePatch({ revision: 2147483647, locked: false }), { revision: 2147483647, locked: false });
  for (const value of [{ revision: 1 }, { revision: 0, opacity: 1 }, { revision: 2147483648, opacity: 1 },
    { revision: '1', angle: 0 }, { revision: 1, fileData: 'forged' }, { revision: 1, angle: 181 }, { revision: 1, locked: null }]) {
    assert.throws(() => validateImagePatch(value), { code: 'VALIDATION_ERROR' });
  }
});

test('P18 names count Unicode code points, preserve literal text and reject paths/control characters', () => {
  for (const name of ['карта.png', '😀'.repeat(255), '<b>карта</b>'.replaceAll('/', '') + '.png', 'extension-is-not-trusted.exe']) {
    assert.equal(validateImageName(name), name);
  }
  for (const name of ['', '  ', '.', '..', 'a/b.png', 'a\\b.png', 'C:map.png', 'a\n.png', 'a\u0000.png', '\ud800', '😀'.repeat(256)]) {
    assert.throws(() => validateImageName(name), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(validateImageMimeType(' IMAGE/PNG '), 'image/png');
  for (const type of [undefined, 'image/svg+xml', 'text/html', 'image/gif', 'application/octet-stream', 'image/png; charset=utf-8']) {
    assert.throws(() => validateImageMimeType(type), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
  }
});
