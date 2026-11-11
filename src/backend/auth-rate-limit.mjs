import { createHash } from 'node:crypto';
import { AuthConfigError } from './auth-config.mjs';
import { ApiError } from './http-errors.mjs';
import { createClientAddressResolver, readTrustedProxyCidrs } from './client-address.mjs';

function positiveInteger(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) > 2147483647) throw new AuthConfigError(`${name}: нужно целое число от 1 до 2147483647.`);
  return Number(value);
}

export function readAuthRateLimitConfig(env = process.env) {
  return Object.freeze({
    windowSeconds: positiveInteger(env, 'AUTH_WINDOW_SECONDS', '900'),
    loginMaxAttempts: positiveInteger(env, 'AUTH_LOGIN_MAX_ATTEMPTS', '10'),
    registerMaxAttempts: positiveInteger(env, 'AUTH_REGISTER_MAX_ATTEMPTS', '5'),
    trustedProxyCidrs: readTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
  });
}

export function createAuthRateLimiter({ config, now = () => performance.now() }) {
  const clientAddress = createClientAddressResolver(config.trustedProxyCidrs);
  const buckets = new Map();
  const maxBuckets = 10000;
  function reject(resetAt, time) {
    throw new ApiError('RATE_LIMITED', { headers: { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - time) / 1000))) } });
  }
  function consume(kind, context, email, limit) {
    const address = clientAddress(context), time = now();
    // Monotonic time and a common window keep insertion order = expiry order.
    // No timer or unbounded scan is needed; expired entries are removed on use.
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt > time) break;
      buckets.delete(key);
    }
    const key = createHash('sha256').update(JSON.stringify([kind, address, email])).digest('hex');
    let bucket = buckets.get(key);
    if (!bucket) {
      // Never evict an active counter: rotating identifiers cannot reset limits.
      if (buckets.size >= maxBuckets) reject(buckets.values().next().value.resetAt, time);
      bucket = { attempts: 0, resetAt: time + config.windowSeconds * 1000 };
      buckets.set(key, bucket);
    }
    if (bucket.attempts >= limit) reject(bucket.resetAt, time);
    bucket.attempts++;
  }
  // Called synchronously after field validation and before any KDF/account SQL.
  // Accepted attempts (success and failure) count; rejected requests don't extend
  // the window. Only hashed identifiers and counters are retained in memory.
  return Object.freeze({
    consumeLogin: (context, normalizedEmail) => consume('login', context, normalizedEmail, config.loginMaxAttempts),
    consumeRegistration: context => consume('register', context, null, config.registerMaxAttempts),
  });
}
