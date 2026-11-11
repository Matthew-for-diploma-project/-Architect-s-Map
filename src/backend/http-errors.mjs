// Public messages are fixed; driver errors, input values and stacks never reach JSON.
const errors = Object.freeze({
  VALIDATION_ERROR: [400, 'Проверьте поля запроса.'],
  INVALID_IMAGE: [400, 'Изображение повреждено или недопустимо.'],
  AUTH_REQUIRED: [401, 'Войдите в аккаунт.'],
  INVALID_CREDENTIALS: [401, 'Неверная почта или пароль.'],
  ORIGIN_REJECTED: [403, 'Источник запроса не разрешён.'],
  NOT_FOUND: [404, 'Ресурс не найден.'],
  METHOD_NOT_ALLOWED: [405, 'Метод запроса не разрешён.'],
  EMAIL_EXISTS: [409, 'Эта почта уже зарегистрирована.'],
  REVISION_CONFLICT: [409, 'Данные изменились. Обновите их перед сохранением.'],
  PAYLOAD_TOO_LARGE: [413, 'Превышен допустимый размер запроса.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Формат тела запроса не поддерживается.'],
  RATE_LIMITED: [429, 'Слишком много попыток. Повторите позже.'],
  DATABASE_UNAVAILABLE: [503, 'База данных временно недоступна.'],
  INTERNAL_ERROR: [500, 'Не удалось выполнить запрос.'],
  // Temporary until the remaining handlers in P19–P22/P27 are added.
  NOT_IMPLEMENTED: [501, 'Операция ещё не реализована.'],
});

export class ApiError extends Error {
  constructor(code, { fields, headers } = {}) {
    const safeCode = Object.hasOwn(errors, code) ? code : 'INTERNAL_ERROR';
    super(errors[safeCode][1]);
    this.name = 'ApiError';
    this.code = safeCode;
    this.status = errors[safeCode][0];
    // Callers supply only public validation messages, never submitted values.
    this.fields = fields;
    this.headers = headers;
  }
}

export function privateResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function apiErrorResponse(error) {
  const known = error instanceof ApiError && Object.hasOwn(errors, error.code);
  const code = known ? error.code : 'INTERNAL_ERROR';
  const body = { code, message: errors[code][1] };
  if (known && error.fields !== undefined) body.fields = error.fields;
  return privateResponse(Response.json({ error: body }, {
    status: errors[code][0],
    headers: known ? error.headers : undefined,
  }));
}
