import { ApiError } from './http-errors.mjs';

export const IMAGE_LIMITS = Object.freeze({ fileBytes: 20971520, bodyBytes: 22020096, metadataBytes: 8192,
  dimension: 16384, pixels: 40000000 });

function invalid() { throw new ApiError('VALIDATION_ERROR'); }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !allowed.includes(key))) invalid();
}
function bounds(value) {
  if (!Array.isArray(value) || value.length !== 2
      || !Array.isArray(value[0]) || value[0].length !== 2 || !Array.isArray(value[1]) || value[1].length !== 2) invalid();
  const [[south, west], [north, east]] = value;
  if (![south, west, north, east].every(Number.isFinite)
      || south < -85 || south >= north || north > 85 || west < -180 || west >= east || east > 180) invalid();
  return [[south, west], [north, east]];
}
function parameter(key, value) {
  if (key === 'bounds') return bounds(value);
  if (key === 'angle' && (!Number.isInteger(value) || value < -180 || value > 180)) invalid();
  if (key === 'opacity' && (!Number.isFinite(value) || value < 0 || value > 1)) invalid();
  if (key === 'locked' && typeof value !== 'boolean') invalid();
  return value;
}
export function validateImageMetadata(value) {
  object(value, ['bounds', 'angle', 'opacity', 'locked']);
  return { bounds: bounds(value.bounds), angle: Object.hasOwn(value, 'angle') ? parameter('angle', value.angle) : 0,
    opacity: Object.hasOwn(value, 'opacity') ? parameter('opacity', value.opacity) : .65,
    locked: Object.hasOwn(value, 'locked') ? parameter('locked', value.locked) : false };
}
export function validateImagePatch(value) {
  object(value, ['revision', 'bounds', 'angle', 'opacity', 'locked']);
  if (!Number.isInteger(value.revision) || value.revision < 1 || value.revision > 2147483647) invalid();
  const result = { revision: value.revision };
  for (const key of ['bounds', 'angle', 'opacity', 'locked']) if (Object.hasOwn(value, key)) result[key] = parameter(key, value[key]);
  if (Object.keys(result).length === 1) invalid();
  return result;
}
export function validateImageName(value) {
  if (typeof value !== 'string' || value.length > 510 || !value.isWellFormed()
      || !value.trim() || [...value].length > 255 || /[\/\\\p{Cc}]/u.test(value)
      || /^[a-z]:/i.test(value) || value === '.' || value === '..') invalid();
  return value;
}
export function validateImageMimeType(value) {
  if (typeof value !== 'string') throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  const type = value.trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  return type;
}
