import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { apiErrorResponse } from './http-errors.mjs';

export function createRequestHandler({ worker, nodeApi, onError = () => console.error('local_adapter_error') }) {
  return async function handleRequest(incoming, outgoing) {
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    let usingWorker = false;
    try {
      let response = await nodeApi(incoming, { signal: controller.signal });
      if (response === null) {
        usingWorker = true;
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        const init = { method: incoming.method, headers, signal: controller.signal };
        if (!['GET', 'HEAD'].includes(incoming.method)) {
          init.body = Readable.toWeb(incoming);
          init.duplex = 'half';
        }
        // Routing never trusts Host as the public origin (P08 uses configuration).
        const url = new URL(incoming.url || '/', 'http://localhost');
        response = await worker.fetch(new Request(url, init));
      } else if (!incoming.readableEnded && (incoming.headers['transfer-encoding'] !== undefined
          || Number(incoming.headers['content-length']) > 0 || incoming.readableLength > 0)) {
        // Early 404/405/413/501: send JSON before closing, without draining a large
        // upload or reusing a connection with an unread request body.
        incoming.pause();
        outgoing.shouldKeepAlive = false;
        outgoing.setHeader('Connection', 'close');
      }
      await writeResponse(incoming, outgoing, response);
    } catch {
      if (controller.signal.aborted) return;
      onError();
      if (outgoing.headersSent) return outgoing.destroy();
      outgoing.shouldKeepAlive = false;
      outgoing.setHeader('Connection', 'close');
      const response = usingWorker
        ? Response.json({ error: 'Ошибка локального HTTP-адаптера' }, { status: 500 })
        : apiErrorResponse(new Error());
      await writeResponse(incoming, outgoing, response).catch(() => outgoing.destroy());
    }
  };
}

async function writeResponse(incoming, outgoing, response) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  if (incoming.method === 'HEAD' || !response.body) {
    await response.body?.cancel();
    outgoing.end();
  } else await pipeline(Readable.fromWeb(response.body), outgoing);
}
