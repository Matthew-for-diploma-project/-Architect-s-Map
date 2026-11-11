import { BlockList, isIP } from 'node:net';
import { AuthConfigError } from './auth-config.mjs';
import { ApiError } from './http-errors.mjs';

function normalizeAddress(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4 and its mapped IPv6 representation must share one rate-limit key.
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const bits = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
}

function addCidr(list, cidr) {
  const parts = cidr.split('/'), family = isIP(parts[0]);
  if (parts.length !== 2 || !family || parts[0].includes('%') || !/^(0|[1-9]\d*)$/.test(parts[1])
      || Number(parts[1]) > (family === 4 ? 32 : 128)) throw new Error('Invalid CIDR');
  list.addSubnet(parts[0], Number(parts[1]), family === 4 ? 'ipv4' : 'ipv6');
}

export function readTrustedProxyCidrs(value = '') {
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    if (value === '') return Object.freeze([]);
    const cidrs = value.split(',').map(part => part.trim());
    if (cidrs.length > 128) throw new Error();
    const list = new BlockList();
    for (const cidr of cidrs) addCidr(list, cidr);
    return Object.freeze(cidrs);
  } catch {
    throw new AuthConfigError('TRUSTED_PROXY_CIDRS: задайте до 128 IPv4/IPv6 CIDR через запятую либо пустую строку.');
  }
}

export function createClientAddressResolver(cidrs) {
  const trusted = new BlockList();
  for (const cidr of cidrs) addCidr(trusted, cidr);
  const isTrusted = address => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return context => {
    const peer = normalizeAddress(context.remoteAddress);
    if (!peer) throw new ApiError('INTERNAL_ERROR');
    if (!isTrusted(peer)) return peer;
    // Only X-Forwarded-For is supported. No Host/proto/Forwarded/X-Real-IP trust.
    const forwarded = context.headers.get('x-forwarded-for');
    if (forwarded === null) return peer;
    if (forwarded.length > 4096) throw new ApiError('VALIDATION_ERROR');
    const parts = forwarded.split(',');
    if (parts.length > 32) throw new ApiError('VALIDATION_ERROR');
    let address = peer;
    for (let i = parts.length - 1; i >= 0 && isTrusted(address); i--) {
      const next = normalizeAddress(parts[i].trim());
      // A malformed hop cannot switch an exhausted client to a fresh fallback
      // bucket. Ignore the unused left prefix once the real client is found.
      if (!next) throw new ApiError('VALIDATION_ERROR');
      address = next;
    }
    return address;
  };
}
