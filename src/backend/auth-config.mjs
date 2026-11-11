// Trusted Node configuration, independent of Host and forwarding headers.
export class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigError';
    this.code = 'AUTH_CONFIG_INVALID';
  }
}

export function readAuthConfig(env = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) {
    throw new AuthConfigError('NODE_ENV: допустимы development, test, production.');
  }
  let url;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch { /* Report the field, never its value. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || env.PUBLIC_ORIGIN !== url.origin
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new AuthConfigError('PUBLIC_ORIGIN: задайте канонический HTTP(S) origin без пути, завершающего /, учётных данных, query или fragment.');
  }
  if (mode === 'production' && url.protocol !== 'https:') {
    throw new AuthConfigError('PUBLIC_ORIGIN: в production требуется HTTPS.');
  }
  const ttl = env.SESSION_TTL_SECONDS ?? '604800';
  if (typeof ttl !== 'string' || !/^[1-9]\d*$/.test(ttl) || !Number.isSafeInteger(Number(ttl))
      || Number(ttl) < 300 || Number(ttl) > 604800) {
    throw new AuthConfigError('SESSION_TTL_SECONDS: нужно целое число от 300 до 604800.');
  }
  return Object.freeze({ publicOrigin: url.origin, secure: url.protocol === 'https:', ttlSeconds: Number(ttl) });
}
