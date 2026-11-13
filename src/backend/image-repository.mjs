// Node-only data access. auth must come from the session service/guard, never
// from a request body. Image HTTP handlers and content validation follow in P18+.
import { ApiError } from './http-errors.mjs';
import { databaseQuery } from './transactions.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
// Keep all PostgreSQL microseconds: converting through JS Date would break
// keyset pagination for images created within the same millisecond.
const metadataColumns = `i.id, i.name, i.mime_type, i.size_bytes, i.width, i.height,
  i.south, i.west, i.north, i.east, i.angle, i.opacity, i.locked, i.revision,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

function ownerId(auth) {
  if (!validId(auth?.user?.id) || !validId(auth?.session?.id)) throw new ApiError('AUTH_REQUIRED');
  return auth.user.id;
}
function validId(value) { return typeof value === 'string' && uuid.test(value); }
function imageId(value) {
  if (!validId(value)) throw new ApiError('VALIDATION_ERROR');
  return value;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw new ApiError('VALIDATION_ERROR');
}
function pageOptions(options) {
  record(options, ['limit', 'after']);
  const { limit = 50, after = null } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('VALIDATION_ERROR');
  if (after !== null) {
    record(after, ['createdAt', 'id']);
    imageId(after.id);
    if (typeof after.createdAt !== 'string' || !timestamp.test(after.createdAt)) throw new ApiError('VALIDATION_ERROR');
    const date = new Date(after.createdAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== after.createdAt.slice(0, 23) + 'Z') {
      throw new ApiError('VALIDATION_ERROR');
    }
  }
  return { limit, after };
}
function toImage(row) {
  return { id: row.id, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes,
    width: row.width, height: row.height, bounds: [[row.south, row.west], [row.north, row.east]],
    angle: row.angle, opacity: row.opacity, locked: row.locked, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, fileUrl: `/api/images/${row.id}/file` };
}
function found(row) {
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

export function createImageRepository({ database }) {
  return {
    async get(auth, id, { client = database.pool } = {}) {
      const userId = ownerId(auth);
      const { rows: [row] } = await databaseQuery(client, `SELECT ${metadataColumns}
        FROM image_metadata AS i WHERE i.user_id = $1::uuid AND i.id = $2::uuid`, [userId, imageId(id)]);
      return toImage(found(row));
    },
    async getFile(auth, id, { client = database.pool } = {}) {
      const userId = ownerId(auth);
      const { rows: [row] } = await databaseQuery(client, `SELECT i.file_data, i.mime_type, i.size_bytes
        FROM images AS i WHERE i.user_id = $1::uuid AND i.id = $2::uuid`, [userId, imageId(id)]);
      found(row);
      return { data: row.file_data, mimeType: row.mime_type, sizeBytes: row.size_bytes };
    },
    async list(auth, options = {}, { client = database.pool } = {}) {
      const userId = ownerId(auth);
      const { limit, after } = pageOptions(options);
      const { rows } = await databaseQuery(client, `SELECT ${metadataColumns}
        FROM image_metadata AS i WHERE i.user_id = $1::uuid
          AND ($2::timestamptz IS NULL OR (i.created_at, i.id) > ($2::timestamptz, $3::uuid))
        ORDER BY i.created_at ASC, i.id ASC LIMIT $4`, [userId, after?.createdAt ?? null, after?.id ?? null, limit + 1]);
      const images = rows.slice(0, limit).map(toImage);
      const last = images.at(-1);
      // Internal typed boundary; P20 will validate/encode the opaque HTTP cursor.
      return { images, next: rows.length > limit ? { createdAt: last.createdAt, id: last.id } : null };
    },
  };
}
