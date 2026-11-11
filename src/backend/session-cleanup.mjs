import { databaseQuery } from './transactions.mjs';

// Explicit maintenance, outside GETs and authorization. Run one bounded batch
// per invocation; concurrent workers skip locked rows and retry them next time.
export async function cleanupExpiredSessions(database) {
  const result = await databaseQuery(database.pool, `
    WITH expired AS (
      SELECT id FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
    )
    DELETE FROM sessions s USING expired
    WHERE s.id = expired.id AND s.expires_at <= CURRENT_TIMESTAMP`);
  return result.rowCount;
}
