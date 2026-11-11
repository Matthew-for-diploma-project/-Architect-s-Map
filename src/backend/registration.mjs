import { validateRegistration, toPublicUser } from './account-validation.mjs';
import { hashPassword } from './passwords.mjs';
import { ApiError } from './http-errors.mjs';

async function databaseOperation(work) {
  try { return await work(); }
  catch { throw new ApiError('DATABASE_UNAVAILABLE'); }
}

// Called by the Node router after Origin, optional session and bounded JSON.
export function createRegistrationHandler({ database, sessions }) {
  return async context => {
    const account = validateRegistration(context.body);
    // Expensive work does not hold a connection, transaction or uniqueness lock.
    const passwordHash = await hashPassword(account.password);
    let client, phase = 'connect', destroy = false;
    const onClientError = () => { destroy = true; };
    try {
      client = await databaseOperation(() => database.pool.connect());
      client.on('error', onClientError);
      phase = 'begin';
      await databaseOperation(() => client.query('BEGIN'));
      phase = 'work';
      const { rows: [user] } = await databaseOperation(() => client.query(`
        INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
        ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING
        RETURNING id, email, name`, [account.email, account.name, passwordHash]));
      if (!user) throw new ApiError('EMAIL_EXISTS');
      await databaseOperation(() => client.query('INSERT INTO layer_settings (user_id) VALUES ($1)', [user.id]));
      const session = await sessions.issue(user.id, { client, replaceSessionId: context.auth?.session?.id ?? null });
      // Build only a safe profile. If serialization fails, roll back before COMMIT.
      const response = Response.json({ user: toPublicUser(user) }, { status: 201, headers: { 'Set-Cookie': session.cookie } });
      phase = 'commit';
      await databaseOperation(() => client.query('COMMIT'));
      phase = 'done';
      return response;
    } catch (error) {
      // A lost BEGIN/COMMIT reply leaves the server state uncertain. Never reuse
      // that connection or report a successful registration/cookie without ACK.
      if (phase === 'begin' || phase === 'commit') destroy = true;
      if (client && phase === 'work' && !destroy) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
      }
      throw error instanceof ApiError ? error : new ApiError(destroy ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR');
    } finally {
      if (client) {
        client.removeListener('error', onClientError);
        client.release(destroy);
      }
    }
  };
}
