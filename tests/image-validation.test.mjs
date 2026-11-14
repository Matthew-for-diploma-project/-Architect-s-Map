import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { IMAGE_LIMITS, validateImageDimensions } from '../src/backend/image-metadata.mjs';
import { validateImageFile } from '../src/backend/image-validation.mjs';
import { images, progressiveJpeg, cmykJpeg, palettePng, losslessWebp, animatedPng, animatedWebp, pngChunks, rebuildPng } from './fixtures/image-files.mjs';
const validate = (bytes, format = 'png', name = 'файл.exe') => validateImageFile({ name, mimeType: `image/${format}`, bytes });

test('P18 full decoding accepts real PNG/JPEG/WebP variants and preserves original bytes', async () => {
  for (const [format, bytes] of [...Object.entries(images), ['jpeg', progressiveJpeg], ['jpeg', cmykJpeg], ['png', palettePng], ['webp', losslessWebp]]) {
    const result = await validate(bytes, format);
    assert.equal(result.mimeType, `image/${format}`); assert.equal(result.name, 'файл.exe');
    assert.deepEqual([result.width, result.height], [3, 2]); assert.deepEqual(result.fileData, bytes);
    assert.notEqual(result.fileData, bytes);
  }
});

test('P18 declared MIME and signature must agree; SVG/HTML/GIF, empty and oversized inputs fail', async () => {
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html>SECRET</html>'), Buffer.from('GIF89a'), Buffer.from('not an image')]) {
    await assert.rejects(validate(bytes), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
  }
  await assert.rejects(validate(images.jpeg), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  await assert.rejects(validate(Buffer.alloc(0)), { code: 'INVALID_IMAGE', status: 400 });
  await assert.rejects(validate(Buffer.alloc(IMAGE_LIMITS.fileBytes + 1)), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  await assert.rejects(validateImageFile({ name: 'x.png', mimeType: 'image/png', bytes: '/etc/passwd' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(validateImageFile({ name: 'x.png', mimeType: 'image/png', bytes: images.png, userId: 'forged' }), { code: 'VALIDATION_ERROR' });
});

test('P18 static single-frame policy rejects real APNG and animated WebP before decoding pixels', async () => {
  assert.equal((await sharp(animatedWebp, { animated: true }).metadata()).pages, 2);
  // The PNG decoder can expose only the default frame. Inspecting APNG chunks
  // is necessary even when metadata alone reports no extra pages.
  assert.equal((await sharp(animatedPng).metadata()).format, 'png');
  await assert.rejects(validate(animatedPng), { code: 'INVALID_IMAGE' });
  await assert.rejects(validate(animatedWebp, 'webp'), { code: 'INVALID_IMAGE' });
});

test('P18 dimension/pixel guards accept exact limits and reject bombs before pixel work', async () => {
  for (const [width, height] of [[1, 1], [16384, 1], [1, 16384], [8000, 5000]]) assert.doesNotThrow(() => validateImageDimensions(width, height));
  for (const dimensions of [[0, 1], [1, 0], [16385, 1], [1, 16385], [8000, 5001], [NaN, 1], [Infinity, 1], ['1', 1]]) {
    assert.throws(() => validateImageDimensions(...dimensions), { code: 'INVALID_IMAGE' });
  }
  for (const [width, height] of [[16385, 1], [8000, 5001]]) {
    const chunks = pngChunks(images.png).map(chunk => ({ ...chunk, data: Buffer.from(chunk.data) }));
    const header = chunks.find(chunk => chunk.type === 'IHDR').data; header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
    await assert.rejects(validate(rebuildPng(chunks)), { code: 'INVALID_IMAGE' });
  }
});

test('P18 rejects truncated containers, wrong CRC/RIFF sizes and trailing polyglot bytes', async () => {
  for (const [format, bytes] of Object.entries(images)) {
    await assert.rejects(validate(bytes.subarray(0, -1), format), { code: 'INVALID_IMAGE' });
    await assert.rejects(validate(Buffer.concat([bytes, Buffer.from('<html>payload</html>')]), format), { code: 'INVALID_IMAGE' });
  }
  const crc = Buffer.from(images.png); crc[29] ^= 1; await assert.rejects(validate(crc), { code: 'INVALID_IMAGE' });
  const riff = Buffer.from(images.webp); riff.writeUInt32LE(riff.length, 4); await assert.rejects(validate(riff, 'webp'), { code: 'INVALID_IMAGE' });
});

test('P18 valid headers are insufficient: corrupted pixel streams fail actual decoding without leaks', async () => {
  const chunks = pngChunks(images.png).map(chunk => ({ ...chunk, data: chunk.type === 'IDAT' ? Buffer.alloc(chunk.data.length) : chunk.data }));
  const broken = rebuildPng(chunks); // Correct container/CRC and dimensions, broken zlib pixels.
  assert.equal((await sharp(broken).metadata()).width, 3);
  await assert.rejects(validate(broken), error => {
    assert.equal(error.code, 'INVALID_IMAGE'); assert.equal(error.status, 400);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /libpng|vips|zlib|IDAT|SECRET|fileData/); return true;
  });
  const jpeg = Buffer.concat([images.jpeg.subarray(0, -8), Buffer.from([255, 217])]);
  assert.equal((await sharp(jpeg).metadata()).width, 3);
  await assert.rejects(validate(jpeg, 'jpeg'), { code: 'INVALID_IMAGE' });
});

test('P18 validates an exact 20 MiB JPEG and snapshots data before asynchronous decoding', async () => {
  let remaining = IMAGE_LIMITS.fileBytes - images.jpeg.length;
  const comments = [];
  while (remaining) {
    let size = Math.min(remaining, 65537);
    if (remaining > size && remaining - size < 4) size -= 4;
    const comment = Buffer.alloc(size); comment[0] = 255; comment[1] = 254; comment.writeUInt16BE(size - 2, 2);
    comments.push(comment); remaining -= size;
  }
  const exact = Buffer.concat([images.jpeg.subarray(0, 2), ...comments, images.jpeg.subarray(2)]);
  assert.equal(exact.length, IMAGE_LIMITS.fileBytes);
  assert.deepEqual((await validate(exact, 'jpeg')).fileData, exact);
  const mutable = Buffer.from(images.png), pending = validate(mutable); mutable.fill(0);
  assert.deepEqual((await pending).fileData, images.png);
});
