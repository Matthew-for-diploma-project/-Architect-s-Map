import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './http-errors.mjs';
import { toPublicUser } from './account-validation.mjs';

const cookieName = 'am_session';
function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    && Buffer.from(token, 'base64url').toString('base64url') === token;
}

export function readSessionToken(cookie) {
  if (typeof cookie !== 'string') return null;
  let token = null, seen = false;
  for (const part of cookie.split(';')) {
    const pair = part.trim();
    const equals = pair.indexOf('=');
    if ((equals < 0 ? pair : pair.slice(0, equals)) !== cookieName) continue;
    // Reject duplicate cookies rather than accepting a shadowed session.
    if (seen) return null;
    seen = true;
    const value = equals < 0 ? '' : pair.slice(equals + 1);
    token = validToken(value) ? value : null;
  }
  return token;
}

function cookieAttributes(config) {
  return `; HttpOnly; SameSite=Lax; Path=/${config.secure ? '; Secure' : ''}`;
}

export function sessionCookie(token, expiresAt, config, now = Date.now()) {
  const expires = new Date(expiresAt);
  if (!validToken(token) || !(expiresAt instanceof Date) || !Number.isFinite(expires.getTime()) || !Number.isFinite(now)) throw new ApiError('INTERNAL_ERROR');
  const remaining = Math.max(0, Math.min(config.ttlSeconds, Math.floor((expires.getTime() - now) / 1000)));
  return `${cookieName}=${token}; Max-Age=${remaining}; Expires=${expires.toUTCString()}${cookieAttributes(config)}`;
}

export function clearSessionCookie(config) {
  return `${cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${cookieAttributes(config)}`;
}

function tokenHash(token) { return createHash('sha256').update(token, 'ascii').digest(); }

export function createSessionService({ database, config }) {
  // The caller can pass its transaction client for P09/P10. This service never
  // commits or releases caller-owned clients. Every query uses bound parameters.
  async function query(client, sql, values) {
    try { return await client.query(sql, values); }
    catch { throw new ApiError('DATABASE_UNAVAILABLE'); }
  }
  return {
    async issue(userId, { client = database.pool, replaceSessionId = null } = {}) {
      const token = randomBytes(32).toString('base64url');
      // One statement is atomic even without an outer transaction. If insertion
      // fails, the current browser's previous session cannot be partly revoked.
      const { rows: [row] } = await query(client, `
        WITH issued AS (
          INSERT INTO sessions (user_id, token_hash, expires_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP + $3 * INTERVAL '1 second')
          RETURNING id, user_id, expires_at
        ), revoked AS (
          DELETE FROM sessions WHERE id = $4::uuid
        )
        SELECT id, user_id, expires_at FROM issued`, [userId, tokenHash(token), config.ttlSeconds, replaceSessionId]);
      return { id: row.id, userId: row.user_id, expiresAt: row.expires_at, cookie: sessionCookie(token, row.expires_at, config) };
    },
    async resolve(headers) {
      const token = readSessionToken(headers.get('cookie'));
      if (!token) return null;
      const { rows: [row] } = await query(database.pool, `
        SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`, [tokenHash(token)]);
      if (!row) return null;
      return { user: toPublicUser(row), session: { id: row.session_id, expiresAt: row.expires_at } };
    },
    async revoke(sessionId, { client = database.pool } = {}) {
      const result = await query(client, 'DELETE FROM sessions WHERE id = $1::uuid', [sessionId]);
      return result.rowCount > 0;
    },
  };
}
