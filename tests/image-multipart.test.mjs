import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readImageMultipart } from '../src/backend/image-multipart.mjs';
import { IMAGE_LIMITS } from '../src/backend/image-metadata.mjs';

const boundary = 'P18-boundary';
const metadata = JSON.stringify({ bounds: [[0, 0], [1, 1]] });
function part(name, value, filename) {
  return Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${filename === undefined ? '' : 'Content-Type: image/png\r\n'}\r\n`),
    Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from('\r\n')]);
}
function request(parts, extraHeaders = {}, ending = true) {
  const bytes = Buffer.concat([...parts, ...(ending ? [Buffer.from(`--${boundary}--\r\n`)] : [])]);
  const input = Readable.from(Array.from({ length: Math.ceil(bytes.length / 8191) }, (_, i) => bytes.subarray(i * 8191, (i + 1) * 8191)), { objectMode: false });
  input.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, ...extraHeaders };
  return input;
}
const valid = () => [part('metadata', metadata), part('file', Buffer.from([1, 2, 3]), 'карта.png')];

test('P18 multipart accepts file/metadata in either order and preserves bytes and UTF-8 filename', async () => {
  for (const parts of [valid(), valid().reverse()]) {
    const result = await readImageMultipart(request(parts));
    assert.deepEqual(result, { file: { name: 'карта.png', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3]) },
      metadata: { bounds: [[0, 0], [1, 1]], angle: 0, opacity: .65, locked: false } });
  }
});

test('P18 multipart permits exact 20 MiB file and 8 KiB metadata; rejects the next byte', async () => {
  const padded = metadata + ' '.repeat(IMAGE_LIMITS.metadataBytes - Buffer.byteLength(metadata));
  const exact = await readImageMultipart(request([part('metadata', padded), part('file', Buffer.alloc(IMAGE_LIMITS.fileBytes), 'exact.png')]));
  assert.equal(exact.file.bytes.length, IMAGE_LIMITS.fileBytes);
  await assert.rejects(readImageMultipart(request([part('metadata', padded + ' '), part('file', 'x', 'a.png')])), { code: 'PAYLOAD_TOO_LARGE' });
  await assert.rejects(readImageMultipart(request([part('metadata', metadata), part('file', Buffer.alloc(IMAGE_LIMITS.fileBytes + 1), 'a.png')])), { code: 'PAYLOAD_TOO_LARGE' });
});

test('P18 multipart rejects missing/duplicate/extra fields or files and invalid metadata/name', async () => {
  for (const parts of [[], [part('metadata', metadata)], [part('file', 'x', 'a.png')], [...valid(), part('metadata', metadata)],
    [...valid(), part('file', 'x', 'b.png')], [...valid(), part('userId', 'forged')],
    [part('metadata', '{bad-json SECRET'), part('file', 'x', 'a.png')], [part('metadata', '{"user_id":"forged"}'), part('file', 'x', 'a.png')],
    [part('metadata', metadata), part('file', 'x', '../map.png')], [part('metadata', 'x', 'meta.json'), part('file', 'x', 'a.png')]]) {
    await assert.rejects(readImageMultipart(request(parts)), error => error.code === 'VALIDATION_ERROR' && !/SECRET|forged/.test(error.message));
  }
  await assert.rejects(readImageMultipart(request([part('metadata', metadata), part('file', '', 'a.png')])), { code: 'INVALID_IMAGE' });
});

test('P18 malformed/truncated multipart, unsupported media/encoding and false lengths fail safely', async () => {
  await assert.rejects(readImageMultipart(request(valid(), {}, false)), { code: 'VALIDATION_ERROR' });
  await assert.rejects(readImageMultipart(request(valid(), { 'content-type': 'application/json' })), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  await assert.rejects(readImageMultipart(request(valid(), { 'content-type': 'multipart/form-data' })), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  await assert.rejects(readImageMultipart(request(valid(), { 'content-type': 'multipart/form-data; boundary=' })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(readImageMultipart(request(valid(), { 'content-encoding': 'gzip' })), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  await assert.rejects(readImageMultipart(request(valid(), { 'content-length': '1' })), { code: 'VALIDATION_ERROR' });
});

test('P18 oversized declared/actual bodies stop reading and leave the remaining stream untouched', async () => {
  const advertised = request(valid(), { 'content-length': String(IMAGE_LIMITS.bodyBytes + 1) });
  let reads = 0;
  const input = { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, pause() {},
    async* iterator() { reads++; yield Buffer.alloc(IMAGE_LIMITS.bodyBytes + 1); reads++; throw new Error('Must not read another chunk'); } };
  await assert.rejects(readImageMultipart(advertised), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(advertised.readableDidRead, false);
  await assert.rejects(readImageMultipart(input), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(reads, 1);
  let tailRead = false;
  const streaming = { headers: input.headers, pause() {}, async* iterator() {
    yield Buffer.concat([part('metadata', metadata), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`)]);
    for (let i = 0; i < 20; i++) yield Buffer.alloc(1024 * 1024);
    yield Buffer.alloc(100);
    tailRead = true; throw new Error('The rest of an oversized file must not be read');
  } };
  await assert.rejects(readImageMultipart(streaming), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(tailRead, false);
});
