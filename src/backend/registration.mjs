import { validateRegistration, toPublicUser } from './account-validation.mjs';
import { hashPassword } from './passwords.mjs';
import { ApiError } from './http-errors.mjs';
import { databaseQuery, withTransaction } from './transactions.mjs';

// Called by the Node router after Origin, optional session and bounded JSON.
export function createRegistrationHandler({ database, sessions, rateLimiter }) {
  return async context => {
    const account = validateRegistration(context.body);
    rateLimiter?.consumeRegistration(context);
    // Expensive work does not hold a connection, transaction or uniqueness lock.
    const passwordHash = await hashPassword(account.password);
    return withTransaction(database.pool, async client => {
      const { rows: [user] } = await databaseQuery(client, `
        INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
        ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING
        RETURNING id, email, name`, [account.email, account.name, passwordHash]);
      if (!user) throw new ApiError('EMAIL_EXISTS');
      await databaseQuery(client, 'INSERT INTO layer_settings (user_id) VALUES ($1)', [user.id]);
      const session = await sessions.issue(user.id, { client, replaceSessionId: context.auth?.session?.id ?? null });
      // Build only a safe profile. If serialization fails, roll back before COMMIT.
      return Response.json({ user: toPublicUser(user) }, { status: 201, headers: { 'Set-Cookie': session.cookie } });
    });
  };
}
