import { validateLogin, toPublicUser } from './account-validation.mjs';
import { verifyPassword } from './passwords.mjs';
import { ApiError } from './http-errors.mjs';
import { databaseQuery, withTransaction } from './transactions.mjs';

export function createLoginHandler({ database, sessions }) {
  return async context => {
    const account = validateLogin(context.body);
    const { rows: [stored] } = await databaseQuery(database.pool,
      'SELECT id, email, name, password_hash FROM users WHERE email = $1', [account.email]);
    const userId = stored?.id, passwordHash = stored?.password_hash;
    // Always run one verification, including real scrypt work for a missing or
    // malformed hash. No connection/row lock is held during the expensive work.
    const matches = await verifyPassword(account.password, passwordHash);
    if (!stored || !matches) throw new ApiError('INVALID_CREDENTIALS');
    return withTransaction(database.pool, async client => {
      // Recheck the verified snapshot and prevent an update/delete until commit.
      // Password/profile changes during scrypt must not authenticate stale data.
      const { rows: [user] } = await databaseQuery(client, `
        SELECT id, email, name FROM users
        WHERE id = $1 AND password_hash = $2 FOR SHARE`, [userId, passwordHash]);
      if (!user) throw new ApiError('INVALID_CREDENTIALS');
      const session = await sessions.issue(user.id, { client, replaceSessionId: context.auth?.session?.id ?? null });
      return Response.json({ user: toPublicUser(user) }, { headers: { 'Set-Cookie': session.cookie } });
    });
  };
}
