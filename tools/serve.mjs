#!/usr/bin/env node
// New Node APIs run before the unchanged ESM Worker in dist/server/index.js.
// PostgreSQL is owned by this Node process, never by the embedded Worker.
import http from 'node:http';
import { createDatabase } from '../src/backend/database.mjs';
import { createNodeApiHandler } from '../src/backend/router.mjs';
import { createRequestHandler } from '../src/backend/http-adapter.mjs';
import { readAuthConfig } from '../src/backend/auth-config.mjs';
import { createSessionService } from '../src/backend/sessions.mjs';
import { createAuthenticationGuard } from '../src/backend/authentication.mjs';
import { createRegistrationHandler } from '../src/backend/registration.mjs';
import { createLoginHandler } from '../src/backend/login.mjs';
import { createMeHandler, createLogoutHandler } from '../src/backend/account-session.mjs';
import { readAuthRateLimitConfig, createAuthRateLimiter } from '../src/backend/auth-rate-limit.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error('Для локального запуска нужен Node.js 22 или новее.');
  process.exit(1);
}

let worker;
try {
  worker = (await import('../dist/server/index.js')).default;
  if (typeof worker?.fetch !== 'function') throw new Error('Missing Worker fetch handler');
} catch (error) {
  console.error('Не удалось загрузить сборку. Выполните npm run build в корне проекта.');
  console.error(error.message);
  process.exit(1);
}

let host = process.env.HOST || '127.0.0.1';
let portValue = process.env.PORT || '3000';
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node tools/serve.mjs [--host 127.0.0.1] [--port 3000]');
    process.exit(0);
  } else if (arg === '--host' && process.argv[i + 1]) host = process.argv[++i];
  else if (arg === '--port' && process.argv[i + 1]) portValue = process.argv[++i];
  else {
    console.error(`Неизвестный или неполный аргумент: ${arg}`);
    process.exit(1);
  }
}
const port = Number(portValue);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT должен быть целым числом от 0 до 65535.');
  process.exit(1);
}

let database;
let authConfig;
let rateLimitConfig;
try {
  database = createDatabase();
  authConfig = readAuthConfig();
  rateLimitConfig = readAuthRateLimitConfig();
  await database.checkConnection();
} catch (error) {
  console.error(['DATABASE_CONFIG_INVALID', 'AUTH_CONFIG_INVALID'].includes(error.code)
    ? error.message : 'PostgreSQL недоступна. Проверьте запуск БД и серверные настройки подключения.');
  await database?.close();
  process.exit(1);
}

const sessions = createSessionService({ database, config: authConfig });
const rateLimiter = createAuthRateLimiter({ config: rateLimitConfig });
const server = http.createServer(createRequestHandler({
  worker,
  nodeApi: createNodeApiHandler({
    database,
    beforeHandle: createAuthenticationGuard({ sessions, config: authConfig }),
    handlers: {
      'auth.register': createRegistrationHandler({ database, sessions, rateLimiter }),
      'auth.login': createLoginHandler({ database, sessions, rateLimiter }),
      'auth.me': createMeHandler(),
      'auth.logout': createLogoutHandler({ sessions, config: authConfig }),
    },
  }),
}));

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Порт ${port} занят. Задайте другой PORT.`
    : `Не удалось запустить сервер: ${error.message}`);
  void shutdown(1);
});

server.listen(port, host, () => {
  const address = server.address();
  const displayHost = host.includes(':') ? `[${host}]` : host;
  console.log(`ГеоКонтекст: http://${displayHost}:${address.port}`);
  console.log('Для остановки нажмите Ctrl+C. После изменений выполните сборку и перезапустите сервер.');
});

let shuttingDown;
function shutdown(exitCode) {
  shuttingDown ??= (async () => {
    await new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(resolve);
      server.closeAllConnections();
    });
    await database.close();
    process.exit(exitCode);
  })();
  return shuttingDown;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(0); });
}
