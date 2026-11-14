// This module and its dependencies run only in Node, outside the Worker build.
import { ApiError, apiErrorResponse, privateResponse } from './http-errors.mjs';
import { readBoundedBody, readJsonBody } from './request-body.mjs';
import { readImageUpload } from './image-validation.mjs';
import { validateImagePatch } from './image-metadata.mjs';

const namespaces = ['/api/auth', '/api/images', '/api/layer-settings'];
const routes = [
  { pattern: /^\/api\/auth\/register$/, methods: { POST: ['auth.register', 'json', 16384] } },
  { pattern: /^\/api\/auth\/login$/, methods: { POST: ['auth.login', 'json', 16384] } },
  { pattern: /^\/api\/auth\/me$/, methods: { GET: ['auth.me', 'none', 0] } },
  { pattern: /^\/api\/auth\/logout$/, methods: { POST: ['auth.logout', 'none', 0] } },
  { pattern: /^\/api\/images$/, private: true, methods: {
    GET: ['images.list', 'none', 0], POST: ['images.create', 'multipart', 22020096],
  } },
  { pattern: /^\/api\/images\/([^/]+)\/file$/, private: true, methods: { GET: ['images.file', 'none', 0] } },
  { pattern: /^\/api\/images\/([^/]+)$/, private: true, methods: {
    PATCH: ['images.update', 'json', 8192], DELETE: ['images.delete', 'none', 0],
  } },
  { pattern: /^\/api\/layer-settings$/, private: true, methods: {
    GET: ['layerSettings.get', 'none', 0], PATCH: ['layerSettings.update', 'json', 8192],
  } },
];

// null means the request still belongs to the original Worker. Nothing is read.
// Production passes its Origin/session guard; it runs before any body or ID.
// Implemented handlers receive a bounded, decoded body; field/file validation is
// their responsibility. P18 validates multipart/images before image handlers.
export function createNodeApiHandler({ database, handlers = {}, beforeHandle } = {}) {
  return async function handleNodeApi(incoming, { signal } = {}) {
    const url = new URL(incoming.url || '/', 'http://localhost');
    if (!namespaces.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return null;
    try {
      const route = routes.find(candidate => candidate.pattern.test(url.pathname));
      if (!route) throw new ApiError('NOT_FOUND');
      const method = incoming.method;
      if (!Object.hasOwn(route.methods, method)) {
        throw new ApiError('METHOD_NOT_ALLOWED', { headers: { Allow: Object.keys(route.methods).join(', ') } });
      }
      const [action, bodyType, bodyLimit] = route.methods[method];
      const match = route.pattern.exec(url.pathname);
      const params = {};
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const context = { action, method, url, headers, params, isPrivate: !!route.private, bodyLimit, database, signal,
        remoteAddress: incoming.socket?.remoteAddress };
      context.auth = await beforeHandle?.(context);
      // Fail closed even if a new entry point forgets to attach its guard.
      if (route.private && (typeof context.auth?.user?.id !== 'string' || !context.auth.user.id)) {
        throw new ApiError('AUTH_REQUIRED');
      }
      if (match[1]) {
        try { params.id = decodeURIComponent(match[1]); }
        catch { throw new ApiError('VALIDATION_ERROR'); }
        if (params.id.includes('/')) throw new ApiError('VALIDATION_ERROR');
      }
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
      // Authorized requests still reject before uploads until handlers exist.
      if (route.private && typeof handler !== 'function') throw new ApiError('NOT_IMPLEMENTED');
      if (bodyType === 'multipart') context.body = await readImageUpload(incoming);
      else if (bodyType === 'json') {
        context.body = await readJsonBody(incoming, bodyLimit);
        if (action === 'images.update') context.body = validateImagePatch(context.body);
      } else {
        const bytes = await readBoundedBody(incoming, bodyLimit);
        if (bodyType !== 'none') context.body = bytes;
      }
      if (typeof handler !== 'function') throw new ApiError('NOT_IMPLEMENTED');
      const response = await handler(context);
      if (!(response instanceof Response)) throw new Error('Invalid API handler response');
      return privateResponse(response);
    } catch (error) { return apiErrorResponse(error); }
  };
}
