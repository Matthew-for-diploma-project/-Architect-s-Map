import { ApiError } from './http-errors.mjs';

// Validate the advertised length before reading, but always count real bytes too.
// destroyOnReturn:false leaves the socket available for a JSON 413 response.
export async function* readBoundedChunks(incoming, maxBytes) {
  const encoding = incoming.headers['content-encoding'];
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }
  const length = incoming.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) {
    throw new ApiError('VALIDATION_ERROR');
  }
  if (length !== undefined && Number(length) > maxBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
  let size = 0;
  let complete = false;
  try {
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        incoming.pause();
        throw new ApiError('PAYLOAD_TOO_LARGE');
      }
      yield bytes;
    }
    if (length !== undefined && size !== Number(length)) throw new ApiError('VALIDATION_ERROR');
    complete = true;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('VALIDATION_ERROR');
  } finally {
    if (!complete) incoming.pause();
  }
}

export async function readBoundedBody(incoming, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const bytes of readBoundedChunks(incoming, maxBytes)) { chunks.push(bytes); size += bytes.length; }
  return Buffer.concat(chunks, size);
}

export async function readJsonBody(incoming, maxBytes) {
  // No compressed input or alternate charset; limits apply to the bytes received.
  const type = incoming.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }
  const bytes = await readBoundedBody(incoming, maxBytes);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError('VALIDATION_ERROR'); }
}
