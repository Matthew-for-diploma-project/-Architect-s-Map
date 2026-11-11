// Node-only password storage. No secrets or driver/crypto error details are logged.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './http-errors.mjs';
import { validatePassword } from './account-validation.mjs';

const scryptAsync = promisify(scrypt);
const options = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const keyBytes = 32;
const saltBytes = 16;
const prefix = 'scrypt$v=1$N=131072,r=8,p=1,dkLen=32$';
const dummySalt = randomBytes(saltBytes);
const dummyKey = Buffer.alloc(keyBytes);

function parseHash(encoded) {
  // Version 1 has exactly one allowed cost profile. Never execute costs supplied
  // by an untrusted/corrupt record (including lower costs or huge allocations).
  if (typeof encoded !== 'string' || encoded.length !== prefix.length + 22 + 1 + 43 || !encoded.startsWith(prefix)) return null;
  const [saltText, keyText] = encoded.slice(prefix.length).split('$');
  if (!/^[A-Za-z0-9_-]{22}$/.test(saltText) || !/^[A-Za-z0-9_-]{43}$/.test(keyText)) return null;
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.length !== saltBytes || key.length !== keyBytes
      || salt.toString('base64url') !== saltText || key.toString('base64url') !== keyText) return null;
  return { salt, key };
}

async function derive(password, salt) {
  const input = Buffer.from(password, 'utf8');
  try { return await scryptAsync(input, salt, keyBytes, options); }
  catch { throw new ApiError('INTERNAL_ERROR'); }
  finally { input.fill(0); }
}

export async function hashPassword(password) {
  validatePassword(password);
  let key;
  try {
    const salt = randomBytes(saltBytes);
    key = await derive(password, salt);
    return prefix + salt.toString('base64url') + '$' + key.toString('base64url');
  } catch { throw new ApiError('INTERNAL_ERROR'); }
  finally { key?.fill(0); }
}

export async function verifyPassword(password, encoded) {
  validatePassword(password);
  const record = parseHash(encoded);
  // Pass null/undefined for an unknown user. Missing, malformed and unsupported
  // records all perform one real scrypt at the same cost and a 32-byte comparison.
  const key = await derive(password, record ? record.salt : dummySalt);
  try {
    const matches = timingSafeEqual(key, record ? record.key : dummyKey);
    return record !== null && matches;
  } catch { throw new ApiError('INTERNAL_ERROR'); }
  finally { key.fill(0); record?.key.fill(0); }
}
