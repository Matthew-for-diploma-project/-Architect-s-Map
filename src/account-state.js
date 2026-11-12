export class AccountApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', fields = {}, uncertain = true } = {}) {
    super(message);
    this.name = 'AccountApiError';
    Object.assign(this, { status, code, fields, uncertain });
  }
}

function publicUser(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['id', 'email', 'name'].every(key => typeof value[key] === 'string')
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)
      || !value.email || value.email.length > 508 || !value.name || [...value.name].length > 80) {
    throw new AccountApiError('Сервер вернул некорректный профиль. Проверьте состояние аккаунта.', { code: 'INVALID_RESPONSE' });
  }
  return Object.freeze({ id: value.id, email: value.email, name: value.name });
}

// Only the browser's HttpOnly cookie carries the session. No credentials enter
// observable state, URLs, Web Storage, or logs.
export function createAccountState({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const listeners = new Set();
  let state = Object.freeze({ phase: 'loading', user: null, pending: null, error: null });
  function publish(next) {
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }
  async function request(operation, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`/api/auth/${operation}`, {
        method: operation === 'me' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      if (operation === 'logout' && response.status === 204) return null;
      let data;
      try { data = await response.json(); }
      catch { throw new AccountApiError('Не удалось прочитать ответ сервера. Проверьте состояние аккаунта.', { code: 'INVALID_RESPONSE' }); }
      if (!response.ok) {
        const error = data?.error;
        const fields = {};
        for (const key of ['email', 'password', 'name']) {
          if (typeof error?.fields?.[key] === 'string') fields[key] = error.fields[key].slice(0, 500);
        }
        let message = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Запрос аккаунта не выполнен.';
        if (error?.code === 'EMAIL_EXISTS' && !fields.email) fields.email = message;
        const retry = response.headers.get('retry-after');
        if (response.status === 429 && /^[1-9]\d{0,9}$/.test(retry || '')) message += ` Повторите через ${Number(retry)} с.`;
        throw new AccountApiError(message, {
          status: response.status, code: typeof error?.code === 'string' ? error.code : 'API_ERROR', fields,
          uncertain: ![400, 401, 403, 409, 413, 415, 429].includes(response.status),
        });
      }
      const expected = operation === 'logout' ? 204 : operation === 'register' ? 201 : 200;
      if (response.status !== expected || !data || !Object.hasOwn(data, 'user') || (data.user === null && operation !== 'me')) {
        throw new AccountApiError('Сервер вернул неожиданный ответ. Проверьте состояние аккаунта.', { code: 'INVALID_RESPONSE' });
      }
      return data.user === null ? null : publicUser(data.user);
    } catch (error) {
      if (error instanceof AccountApiError) throw error;
      throw new AccountApiError(controller.signal.aborted
        ? 'Сервер не ответил вовремя. Проверьте состояние аккаунта и повторите попытку.'
        : 'Не удалось связаться с сервером. Проверьте соединение и состояние аккаунта.');
    } finally { clearTimeout(timer); }
  }
  async function perform(operation, body) {
    if (state.pending || (operation !== 'me' && !['guest', 'authenticated'].includes(state.phase))) return null;
    const previous = state;
    publish({ phase: 'loading', user: previous.user, pending: operation, error: null });
    try {
      const user = await request(operation, body);
      publish({ phase: user ? 'authenticated' : 'guest', user, pending: null, error: null });
      return user;
    } catch (error) {
      // Every logout failure needs a visible error/recheck, including a known
      // rejection such as 403. A fresh me also reconciles lost mutation replies
      // without automatically repeating a POST or assuming a successful exit.
      publish(operation === 'me' || operation === 'logout' || error.uncertain
        ? { phase: 'error', user: null, pending: null, error: error.message }
        : { ...previous, pending: null, error: null });
      throw error;
    }
  }
  return Object.freeze({
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    refresh: () => perform('me'),
    authenticate(mode, data) {
      if (!['login', 'register'].includes(mode)) throw new TypeError('Unknown account operation');
      return perform(mode, { email: data.email, password: data.password, ...(mode === 'register' ? { name: data.name } : {}) });
    },
    logout: () => perform('logout'),
    canUsePersonalActions: () => ['guest', 'authenticated'].includes(state.phase) && !state.pending,
  });
}
