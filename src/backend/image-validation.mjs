import sharp from 'sharp';
import { ApiError } from './http-errors.mjs';
import { IMAGE_LIMITS, validateImageDimensions, validateImageName, validateImageMimeType } from './image-metadata.mjs';
import { readImageMultipart } from './image-multipart.mjs';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid() { throw new ApiError('INVALID_IMAGE'); }
function format(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(pngSignature.subarray(0, 4))) return 'png';
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
}
function pngContainer(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)) invalid();
  let offset = 8, header = false, data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[a-zA-Z]{4}$/.test(type) || (bytes[offset + 6] & 32) || (!header && type !== 'IHDR')) invalid();
    if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid(); header = true;
      validateImageDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
    }
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { if (!data || length !== 0 || end !== bytes.length) invalid(); return; }
    if (!(bytes[offset + 4] & 32) && !['IHDR', 'PLTE', 'IDAT'].includes(type)) invalid();
    offset = end;
  }
  invalid();
}
function jpegContainer(bytes) {
  let offset = 2, frames = 0, scans = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (offset !== bytes.length || frames !== 1 || !scans) invalid(); return; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) invalid();
    if (marker === 1) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (++frames !== 1 || length < 8) invalid();
      validateImageDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
    if (marker === 218) {
      scans++;
      // Entropy data escapes FF as FF00 and permits restart markers. Other
      // markers start the next segment/scan, including progressive JPEG scans.
      while (offset < bytes.length) {
        const start = bytes.indexOf(255, offset); if (start < 0) invalid();
        let next = start + 1; while (bytes[next] === 255) next++;
        const code = bytes[next];
        if (code === 0 || (code >= 208 && code <= 215)) offset = next + 1;
        else { offset = start; break; }
      }
    }
  }
  invalid();
}
function webpContainer(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, images = 0, extended = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length, padded = end + (length & 1);
    if (padded > bytes.length || ((length & 1) && bytes[end] !== 0)) invalid();
    if (type === 'ANIM' || type === 'ANMF') invalid();
    if (type === 'VP8X') {
      if (extended || offset !== 12 || length !== 10 || (bytes[offset + 8] & 2)) invalid(); extended = true;
      validateImageDimensions(1 + bytes.readUIntLE(offset + 12, 3), 1 + bytes.readUIntLE(offset + 15, 3));
    }
    if (type === 'VP8 ' || type === 'VP8L') images++;
    offset = padded;
  }
  if (offset !== bytes.length || images !== 1) invalid();
}

export async function validateImageFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some(key => !['name', 'mimeType', 'bytes'].includes(key)) || !Buffer.isBuffer(file.bytes)) {
    throw new ApiError('VALIDATION_ERROR');
  }
  if (file.bytes.length > IMAGE_LIMITS.fileBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
  if (!file.bytes.length) invalid();
  const name = validateImageName(file.name), mimeType = validateImageMimeType(file.mimeType);
  // Snapshot before the first await: validate and return exactly the same bytes,
  // even if a caller still has a mutable reference to its original Buffer.
  const bytes = Buffer.from(file.bytes), detected = format(bytes);
  if (mimeType !== `image/${detected}`) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  ({ png: pngContainer, jpeg: jpegContainer, webp: webpContainer })[detected](bytes);
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: IMAGE_LIMITS.pixels, limitInputChannels: 5, unlimited: false });
  try {
    const metadata = await image.metadata();
    if (metadata.format !== detected || (metadata.pages ?? 1) !== 1 || metadata.delay !== undefined || metadata.loop !== undefined) invalid();
    validateImageDimensions(metadata.width, metadata.height);
    // metadata() reads headers only. stats() traverses decoded pixels without
    // re-encoding or building a large raw output buffer for the response.
    await image.stats();
    return { name, mimeType, fileData: bytes, width: metadata.width, height: metadata.height };
  } catch { invalid(); }
  finally { image.destroy(); }
}

export async function readImageUpload(incoming) {
  const { file, metadata } = await readImageMultipart(incoming);
  return { ...await validateImageFile(file), ...metadata };
}
