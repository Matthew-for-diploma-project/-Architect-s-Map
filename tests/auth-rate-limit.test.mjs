import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { readAuthRateLimitConfig, createAuthRateLimiter } from '../src/backend/auth-rate-limit.mjs';
import { createClientAddressResolver } from '../src/backend/client-address.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';
import { createAuthenticationGuard } from '../src/backend/authentication.mjs';
import { createLoginHandler } from '../src/backend/login.mjs';
import { createRegistrationHandler } from '../src/backend/registration.mjs';
import { apiErrorResponse } from '../src/backend/http-errors.mjs';

const context = (remoteAddress = '192.0.2.1', headers = {}) => ({ remoteAddress, headers: new Headers(headers) });
const options = values => readAuthRateLimitConfig({ AUTH_WINDOW_SECONDS: '10', AUTH_LOGIN_MAX_ATTEMPTS: '2', AUTH_REGISTER_MAX_ATTEMPTS: '2', ...values });
function rejected(work, retry) {
  assert.throws(work, error => {
    assert.equal(error.code, 'RATE_LIMITED');
    if (retry !== undefined) assert.equal(error.headers['Retry-After'], retry);
    return true;
  });
}

test('P12 rate configuration has explicit defaults, immutable CIDRs and safe positive integer validation', () => {
  const defaults = readAuthRateLimitConfig({});
  assert.deepEqual(defaults, { windowSeconds: 900, loginMaxAttempts: 10, registerMaxAttempts: 5, trustedProxyCidrs: [] });
  assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.trustedProxyCidrs));
  assert.deepEqual(options({ TRUSTED_PROXY_CIDRS: '127.0.0.1/32, ::1/128' }).trustedProxyCidrs, ['127.0.0.1/32', '::1/128']);
  for (const name of ['AUTH_WINDOW_SECONDS', 'AUTH_LOGIN_MAX_ATTEMPTS', 'AUTH_REGISTER_MAX_ATTEMPTS']) {
    for (const value of ['', '0', '-1', '01', '1.5', '1e3', ' 10', '2147483648', 'SECRET_CONFIG', 2]) {
      assert.throws(() => readAuthRateLimitConfig({ [name]: value }), error => {
        assert.equal(error.code, 'AUTH_CONFIG_INVALID');
        assert.ok(error.message.includes(name));
        assert.doesNotMatch(error.stack, /SECRET_CONFIG/);
        return true;
      });
    }
    assert.ok(readAuthRateLimitConfig({ [name]: '2147483647' }));
  }
});

test('proxy configuration rejects names, ports, scope IDs, invalid masks and empty/oversized lists without echoing values', () => {
  for (const value of ['localhost', '*', 'true', '127.0.0.1', '127.0.0.1/33', '::1/129', '127.0.0.1/-1',
    '127.0.0.1/032', '127.0.0.1/32,', ',::1/128', '[::1]/128', 'fe80::1%eth0/64', '127.0.0.1:3000/32',
    'SECRET_PROXY/32', Array(130).fill('::1/128').join(','), 'x'.repeat(8193), ['127.0.0.1/32']]) {
    assert.throws(() => options({ TRUSTED_PROXY_CIDRS: value }), error => {
      assert.equal(error.code, 'AUTH_CONFIG_INVALID');
      assert.match(error.message, /TRUSTED_PROXY_CIDRS/);
      assert.doesNotMatch(error.stack, /SECRET_PROXY/);
      return true;
    });
  }
});

test('untrusted TCP peers cannot select their IP using forwarding headers or user input', () => {
  const resolve = createClientAddressResolver(['10.0.0.0/8']);
  for (const forwarded of ['203.0.113.1', '203.0.113.2', 'garbage', '::1']) {
    assert.equal(resolve(context('192.0.2.1', { 'X-Forwarded-For': forwarded, Forwarded: 'for=198.51.100.4', 'X-Real-IP': '198.51.100.5' })), '192.0.2.1');
  }
  assert.throws(() => resolve({ ...context(), remoteAddress: undefined }), { code: 'INTERNAL_ERROR' });
  assert.throws(() => resolve(context('not an IP')), { code: 'INTERNAL_ERROR' });
});

test('trusted proxy chains are walked right to left; malformed used hops cannot select a fallback bucket', () => {
  const resolve = createClientAddressResolver(['10.0.0.0/8', '2001:db8:ffff::/48']);
  assert.equal(resolve(context('10.0.0.1', { 'x-forwarded-for': '198.51.100.9, 203.0.113.2, 10.0.0.2' })), '203.0.113.2');
  assert.equal(resolve(context('2001:db8:ffff::1', { 'x-forwarded-for': '2001:db8:1::9, 2001:db8:ffff::2' })), '2001:db8:1::9');
  assert.equal(resolve(context('10.0.0.1', { 'x-forwarded-for': '10.0.0.3, 10.0.0.2' })), '10.0.0.3');
  assert.equal(resolve(context('10.0.0.1', { 'x-forwarded-for': 'garbage, 203.0.113.2, 10.0.0.2' })), '203.0.113.2');
  for (const value of ['', 'garbage', 'unknown', '203.0.113.9:456', '[2001:db8::1]', 'fe80::1%eth0',
    '203.0.113.9,', '203.0.113.9, garbage', '"203.0.113.9"', Array(33).fill('203.0.113.9').join(','), 'x'.repeat(4097)]) {
    assert.throws(() => resolve(context('10.0.0.1', { 'x-forwarded-for': value })), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(resolve(context('10.0.0.1')), '10.0.0.1');
  assert.equal(resolve(context('10.0.0.1', { Forwarded: 'for=203.0.113.3', 'X-Real-IP': '203.0.113.4' })), '10.0.0.1');
});

test('IPv6 spelling and IPv4-mapped forms share canonical client identities and quota', () => {
  const resolve = createClientAddressResolver(['127.0.0.1/32']);
  assert.equal(resolve(context('::ffff:127.0.0.1', { 'x-forwarded-for': '::ffff:c000:201' })), '192.0.2.1');
  const mappedProxy = createClientAddressResolver(['::ffff:7f00:0/104']);
  assert.equal(mappedProxy(context('127.0.0.1', { 'x-forwarded-for': '192.0.2.1' })), '192.0.2.1');
  const limiter = createAuthRateLimiter({ config: options({ AUTH_LOGIN_MAX_ATTEMPTS: '1' }) });
  limiter.consumeLogin(context('192.0.2.1'), 'a@example.test');
  rejected(() => limiter.consumeLogin(context('0:0:0:0:0:ffff:c000:201'), 'a@example.test'));
  limiter.consumeLogin(context('2001:0DB8:0:0:0:0:0:1'), 'a@example.test');
  rejected(() => limiter.consumeLogin(context('2001:db8::1'), 'a@example.test'));
});

test('fixed windows enforce the exact allowance, ceil Retry-After, recover at expiry and are not extended by rejections', async () => {
  let time = 0;
  const limiter = createAuthRateLimiter({ config: options(), now: () => time });
  limiter.consumeLogin(context(), 'a@example.test');
  limiter.consumeLogin(context(), 'a@example.test');
  rejected(() => limiter.consumeLogin(context(), 'a@example.test'), '10');
  time = 1001;
  rejected(() => limiter.consumeLogin(context(), 'a@example.test'), '9');
  time = 9999;
  let limited;
  assert.throws(() => limiter.consumeLogin(context(), 'a@example.test'), error => { limited = error; return error.code === 'RATE_LIMITED'; });
  const response = apiErrorResponse(limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Повторите позже.' } });
  time = 10000;
  limiter.consumeLogin(context(), 'a@example.test');
  limiter.consumeLogin(context(), 'a@example.test');
  rejected(() => limiter.consumeLogin(context(), 'a@example.test'), '10');
});

test('login pairs, registration IPs and actions have independent counters', () => {
  const limiter = createAuthRateLimiter({ config: options({ AUTH_LOGIN_MAX_ATTEMPTS: '1', AUTH_REGISTER_MAX_ATTEMPTS: '1' }) });
  limiter.consumeLogin(context(), 'a@example.test');
  limiter.consumeLogin(context(), 'b@example.test');
  limiter.consumeLogin(context('192.0.2.2'), 'a@example.test');
  limiter.consumeRegistration(context());
  rejected(() => limiter.consumeRegistration(context()));
  limiter.consumeRegistration(context('192.0.2.2'));
  rejected(() => limiter.consumeLogin(context(), 'a@example.test'));
});

test('concurrent requests reserve allowance synchronously before any async account work', async () => {
  const limiter = createAuthRateLimiter({ config: options({ AUTH_LOGIN_MAX_ATTEMPTS: '3' }) });
  const results = await Promise.allSettled(Array.from({ length: 30 }, async () => {
    limiter.consumeLogin(context(), 'a@example.test');
    await Promise.resolve();
  }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'RATE_LIMITED').length, 27);
});

test('10,000-entry capacity rejects new identities without evicting active counters and recovers after expiry', () => {
  let time = 0;
  const limiter = createAuthRateLimiter({ config: options(), now: () => time });
  for (let n = 0; n < 10000; n++) limiter.consumeRegistration(context(`198.18.${n >>> 8}.${n & 255}`));
  rejected(() => limiter.consumeRegistration(context('192.0.2.9')), '10');
  limiter.consumeRegistration(context('198.18.0.0'));
  rejected(() => limiter.consumeRegistration(context('198.18.0.0')), '10');
  time = 10000;
  limiter.consumeRegistration(context('192.0.2.9'));
  limiter.consumeRegistration(context('198.18.0.0'));
});

test('wired account handlers use normalized email and reject exhausted quota before real scrypt or account SQL', async () => {
  const config = options({ AUTH_LOGIN_MAX_ATTEMPTS: '1', AUTH_REGISTER_MAX_ATTEMPTS: '1' });
  const limiter = createAuthRateLimiter({ config });
  limiter.consumeLogin(context(), 'alice@example.test');
  limiter.consumeRegistration(context());
  const database = { pool: { query() { throw new Error('Account SQL must not run'); }, connect() { throw new Error('No transaction'); } } };
  const authConfig = { publicOrigin: 'https://map.example.test' };
  const handle = createNodeApiHandler({ database, beforeHandle: createAuthenticationGuard({ sessions: { resolve: async () => null }, config: authConfig }), handlers: {
    'auth.login': createLoginHandler({ database, rateLimiter: limiter }),
    'auth.register': createRegistrationHandler({ database, rateLimiter: limiter }),
  } });
  let work = 0;
  const hook = createHook({ init(id, type) { if (type === 'SCRYPTREQUEST') work++; } });
  hook.enable();
  try {
    for (const action of ['login', 'register']) {
      const body = { email: ' ALICE@EXAMPLE.TEST ', password: 'Valid fixture password', ...(action === 'register' ? { name: 'Алиса' } : {}) };
      const incoming = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: '/api/auth/' + action,
        socket: { remoteAddress: '192.0.2.1' }, headers: { origin: authConfig.publicOrigin, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' } });
      const response = await handle(incoming);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('set-cookie'), null);
      const text = await response.text();
      assert.doesNotMatch(text, /alice|password|SQL|stack/);
    }
  } finally { hook.disable(); }
  assert.equal(work, 0);
});
