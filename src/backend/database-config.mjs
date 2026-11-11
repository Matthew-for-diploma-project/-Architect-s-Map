// Node-only configuration. Never import this module into the Worker or browser.
import { readFileSync } from 'node:fs';

export class DatabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConfigError';
    this.code = 'DATABASE_CONFIG_INVALID';
  }
}

function invalid(name, requirement) {
  // Describe the field, never its value: URLs and file paths can contain secrets.
  throw new DatabaseConfigError(`${name}: ${requirement}`);
}

function connectionUrl(value, name) {
  if (typeof value !== 'string' || !value) invalid(name, 'не задана. Настройте серверное окружение по .env.example.');
  let url;
  try { url = new URL(value); } catch { invalid(name, 'нужен URL PostgreSQL с пользователем, паролем, сервером и именем БД.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      url.search || url.hash || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    invalid(name, 'нужен URL PostgreSQL без query/fragment; TLS задаётся через DATABASE_SSL.');
  }
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { invalid(name, 'некорректное percent-кодирование.'); }
  if (!user || !password || !database || /[\u0000-\u001f\u007f]/u.test(user + password + database) || database.includes('/')) {
    invalid(name, 'нужны непустые пользователь, пароль и одно имя БД без управляющих символов.');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid(name, 'порт должен быть в диапазоне 1–65535.');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, user, password, database };
}

function positiveInteger(env, name, fallback, max = 2147483647) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    invalid(name, `нужно целое число от 1 до ${max}.`);
  }
  return Number(value);
}

export function readDatabaseConfig(env = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) invalid('NODE_ENV', 'допустимы development, test, production.');
  const testing = mode === 'test';
  const name = testing ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const connection = connectionUrl(env[name], name);
  if (testing) {
    if (!connection.database.endsWith('_test')) invalid(name, 'имя тестовой БД должно оканчиваться на _test.');
    if (env.DATABASE_URL) {
      const working = connectionUrl(env.DATABASE_URL, 'DATABASE_URL');
      if (working.database === connection.database || working.user === connection.user) {
        invalid(name, 'используйте отдельные имя БД и роль, отличающиеся от DATABASE_URL.');
      }
    }
  }
  const sslMode = env.DATABASE_SSL ?? 'verify';
  if (!['disable', 'verify'].includes(sslMode)) invalid('DATABASE_SSL', 'допустимы disable или verify.');
  if (sslMode === 'disable' && env.DATABASE_CA_FILE) invalid('DATABASE_CA_FILE', 'применяется только при DATABASE_SSL=verify.');
  let ssl = false;
  if (sslMode === 'verify') {
    ssl = { rejectUnauthorized: true };
    if (env.DATABASE_CA_FILE) {
      try { ssl.ca = readFileSync(env.DATABASE_CA_FILE, 'utf8'); }
      catch { invalid('DATABASE_CA_FILE', 'не удалось прочитать сертификат CA.'); }
      if (!ssl.ca.trim()) invalid('DATABASE_CA_FILE', 'файл CA пуст.');
    }
  }
  // Separate fields prevent URI options from overriding TLS, timeouts or identity.
  return {
    ...connection,
    ssl,
    max: positiveInteger(env, 'DB_POOL_MAX', 5, 20),
    connectionTimeoutMillis: positiveInteger(env, 'DB_CONNECT_TIMEOUT_MS', 5000),
    statement_timeout: positiveInteger(env, 'DB_STATEMENT_TIMEOUT_MS', 10000),
    application_name: `geokontekst:${process.pid}`,
  };
}
