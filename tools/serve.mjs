#!/usr/bin/env node
// Local HTTP adapter for the unchanged ESM Worker in dist/server/index.js.
// PostgreSQL is owned by this Node process, never by the embedded Worker.
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDatabase } from '../src/backend/database.mjs';

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
try {
  database = createDatabase();
  await database.checkConnection();
} catch (error) {
  console.error(error.code === 'DATABASE_CONFIG_INVALID' ? error.message : 'PostgreSQL недоступна. Проверьте запуск БД и серверные настройки подключения.');
  await database?.close();
  process.exit(1);
}

const server = http.createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  incoming.once('aborted', () => controller.abort());
  outgoing.once('close', () => {
    if (!outgoing.writableFinished) controller.abort();
  });
  try {
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    }
    const init = { method: incoming.method, headers, signal: controller.signal };
    if (!['GET', 'HEAD'].includes(incoming.method)) {
      init.body = Readable.toWeb(incoming);
      init.duplex = 'half';
    }
    // A fixed origin avoids using an untrusted Host header for URL routing.
    const url = new URL(incoming.url || '/', 'http://localhost');
    const response = await worker.fetch(new Request(url, init));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (incoming.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      outgoing.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), outgoing);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('local_adapter_error', error.message);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify({ error: 'Ошибка локального HTTP-адаптера' }));
    } else outgoing.destroy();
  }
});

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
