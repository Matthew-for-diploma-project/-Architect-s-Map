import busboy from 'busboy';
import { finished } from 'node:stream/promises';
import { ApiError } from './http-errors.mjs';
import { readBoundedChunks } from './request-body.mjs';
import { IMAGE_LIMITS, validateImageMetadata, validateImageName, validateImageMimeType } from './image-metadata.mjs';

function writable(parser) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { parser.removeListener('drain', drained); parser.removeListener('error', failed); parser.removeListener('close', closed); };
    const drained = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new ApiError('VALIDATION_ERROR')); };
    const closed = () => { cleanup(); reject(new ApiError('VALIDATION_ERROR')); };
    parser.once('drain', drained); parser.once('error', failed); parser.once('close', closed);
  });
}

// Stream only the bounded file; never concatenate the full multipart request.
// The caller must run method/Origin/session guards before invoking this reader.
export async function readImageMultipart(incoming) {
  const type = incoming.headers['content-type'];
  if (typeof type !== 'string' || !/^multipart\/form-data\s*;/i.test(type)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  let parser;
  try {
    parser = busboy({ headers: incoming.headers, preservePath: true, defParamCharset: 'utf8',
      limits: { fileSize: IMAGE_LIMITS.fileBytes + 1, fieldSize: IMAGE_LIMITS.metadataBytes + 1,
        files: 2, fields: 2, parts: 3, headerPairs: 100 } });
  } catch { throw new ApiError('VALIDATION_ERROR'); }
  let failure, fileCount = 0, fieldCount = 0, file, metadata;
  const fail = code => { failure ??= new ApiError(code); };
  parser.on('error', () => fail('VALIDATION_ERROR'));
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => fail('VALIDATION_ERROR'));
  parser.on('file', (name, stream, info) => {
    fileCount++;
    stream.on('error', () => fail('VALIDATION_ERROR'));
    stream.on('limit', () => fail('PAYLOAD_TOO_LARGE'));
    if (name !== 'file' || fileCount !== 1 || !['7bit', '8bit', 'binary'].includes(info.encoding.toLowerCase())) {
      fail('VALIDATION_ERROR'); stream.resume(); return;
    }
    try { file = { name: validateImageName(info.filename), mimeType: validateImageMimeType(info.mimeType), chunks: [], size: 0 }; }
    catch (error) { failure ??= error; stream.resume(); return; }
    stream.on('data', bytes => {
      file.size += bytes.length;
      if (file.size > IMAGE_LIMITS.fileBytes) fail('PAYLOAD_TOO_LARGE');
      if (!failure) file.chunks.push(bytes);
    });
  });
  parser.on('field', (name, value, info) => {
    fieldCount++;
    if (info.valueTruncated || Buffer.byteLength(value, 'utf8') > IMAGE_LIMITS.metadataBytes) { fail('PAYLOAD_TOO_LARGE'); return; }
    if (name !== 'metadata' || fieldCount !== 1 || info.nameTruncated) { fail('VALIDATION_ERROR'); return; }
    try { metadata = validateImageMetadata(JSON.parse(value)); }
    catch { fail('VALIDATION_ERROR'); }
  });
  const completion = finished(parser, { cleanup: true }).catch(() => fail('VALIDATION_ERROR'));
  try {
    for await (const bytes of readBoundedChunks(incoming, IMAGE_LIMITS.bodyBytes)) {
      const accepted = parser.write(bytes);
      if (failure) throw failure;
      if (!accepted) await writable(parser);
      if (failure) throw failure;
    }
    parser.end();
    await completion;
    if (failure) throw failure;
    if (fileCount !== 1 || fieldCount !== 1 || !file || !metadata) throw new ApiError('VALIDATION_ERROR');
    if (!file.size) throw new ApiError('INVALID_IMAGE');
    return { file: { name: file.name, mimeType: file.mimeType, bytes: Buffer.concat(file.chunks, file.size) }, metadata };
  } catch (error) {
    incoming.pause();
    throw error instanceof ApiError ? error : new ApiError('VALIDATION_ERROR');
  } finally {
    parser.destroy();
    await completion;
  }
}
