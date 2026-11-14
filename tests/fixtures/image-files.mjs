import sharp from 'sharp';

export const boundary = 'P18-fixture-boundary';
export const metadata = { bounds: [[54.6, 39.7], [54.7, 39.8]] };
const source = { create: { width: 3, height: 2, channels: 4, background: { r: 70, g: 150, b: 110, alpha: .7 } } };
export const images = Object.fromEntries(await Promise.all(['png', 'jpeg', 'webp'].map(async format => [format, await sharp(source)[format]().toBuffer()])));
export const progressiveJpeg = await sharp(source).jpeg({ progressive: true }).toBuffer();
export const cmykJpeg = await sharp(source).toColourspace('cmyk').jpeg().toBuffer();
export const palettePng = await sharp(source).png({ palette: true }).toBuffer();
export const losslessWebp = await sharp(source).webp({ lossless: true }).toBuffer();

export function pngChunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
export function pngChunks(bytes) {
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    chunks.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}
export function rebuildPng(chunks) { return Buffer.concat([images.png.subarray(0, 8), ...chunks.map(({ type, data }) => pngChunk(type, data))]); }
const chunks = pngChunks(images.png), control = Buffer.alloc(8); control.writeUInt32BE(2);
function frame(sequence) {
  const data = Buffer.alloc(26); data.writeUInt32BE(sequence); data.writeUInt32BE(3, 4); data.writeUInt32BE(2, 8);
  data.writeUInt16BE(1, 20); data.writeUInt16BE(10, 22); return pngChunk('fcTL', data);
}
const compressed = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
const secondData = Buffer.alloc(4 + compressed.length); secondData.writeUInt32BE(2); compressed.copy(secondData, 4);
export const animatedPng = Buffer.concat([images.png.subarray(0, 8), pngChunk('IHDR', chunks.find(c => c.type === 'IHDR').data),
  pngChunk('acTL', control), frame(0), pngChunk('IDAT', compressed), frame(1), pngChunk('fdAT', secondData), pngChunk('IEND', Buffer.alloc(0))]);
const raw = Buffer.alloc(3 * 4 * 3);
for (let pixel = 0; pixel < 12; pixel++) raw[pixel * 3 + (pixel < 6 ? 0 : 2)] = 255;
export const animatedWebp = await sharp(raw, { raw: { width: 3, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();

export function multipart({ bytes = images.png, name = 'карта.png', mimeType = 'image/png', fields = metadata } = {}) {
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(fields)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  return Buffer.concat([prefix, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
}
export const multipartType = `multipart/form-data; boundary=${boundary}`;
