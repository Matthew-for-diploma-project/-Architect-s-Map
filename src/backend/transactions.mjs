import { ApiError } from './http-errors.mjs';

async function databaseOperation(work) {
  try { return await work(); }
  catch { throw new ApiError('DATABASE_UNAVAILABLE'); }
}

export function databaseQuery(target, sql, values) {
  return databaseOperation(() => target.query(sql, values));
}

// Run all writes and response construction on one checked-out client. The value
// is returned only after COMMIT acknowledgement. No automatic transaction retry.
export async function withTransaction(pool, work) {
  let client, phase = 'connect', destroy = false;
  const onClientError = () => { destroy = true; };
  try {
    client = await databaseOperation(() => pool.connect());
    client.on('error', onClientError);
    phase = 'begin';
    await databaseQuery(client, 'BEGIN');
    phase = 'work';
    const result = await work(client);
    phase = 'commit';
    await databaseQuery(client, 'COMMIT');
    phase = 'done';
    return result;
  } catch (error) {
    // Lost BEGIN/COMMIT replies have uncertain server outcomes; close the
    // connection rather than returning it to the pool or reporting success.
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
}
