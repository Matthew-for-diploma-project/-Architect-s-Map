import { ApiError } from './http-errors.mjs';

const messages = Object.freeze({
  email: 'Укажите почту длиной до 254 символов с адресом и доменом.',
  password: 'Пароль должен содержать от 12 до 128 Unicode-символов.',
  name: 'Укажите имя длиной от 1 до 80 символов без управляющих символов.',
  form: 'Передайте объект только с разрешёнными полями.',
});

function inRange(value, min, max) {
  // UTF-16 length bounds allocation; the policy counts Unicode code points.
  if (typeof value !== 'string' || value.length > max * 2 || !value.isWellFormed()) return false;
  const length = [...value].length;
  return length >= min && length <= max;
}

function validEmail(value) {
  if (!inRange(value, 3, 254) || /[\s\p{Cc}]/u.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const domain = parts[1];
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function validatePassword(password) {
  // Reject lone surrogates: UTF-8 would otherwise replace different inputs with
  // the same byte sequence. Do not trim, case-fold or Unicode-normalize passwords.
  if (!inRange(password, 12, 128)) {
    throw new ApiError('VALIDATION_ERROR', { fields: { password: messages.password } });
  }
}

function validateAccount(body, registration) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    throw new ApiError('VALIDATION_ERROR', { fields: { _form: messages.form } });
  }
  const allowed = registration ? ['email', 'password', 'name'] : ['email', 'password'];
  const fields = {};
  if (Object.keys(body).some(key => !allowed.includes(key))) fields._form = messages.form;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  if (!Object.hasOwn(body, 'email') || !validEmail(email)) fields.email = messages.email;
  if (!Object.hasOwn(body, 'password') || !inRange(body.password, 12, 128)) fields.password = messages.password;
  if (registration && (!Object.hasOwn(body, 'name') || !inRange(name, 1, 80) || /\p{Cc}/u.test(name))) {
    fields.name = messages.name;
  }
  if (Object.keys(fields).length) throw new ApiError('VALIDATION_ERROR', { fields });
  // Internal credentials for the registration/login handler, never an API reply.
  return registration ? { email, password: body.password, name } : { email, password: body.password };
}

export function validateRegistration(body) { return validateAccount(body, true); }
export function validateLogin(body) { return validateAccount(body, false); }

// Explicit projection: neither a database row nor validated credentials may be
// spread into an HTTP response. Keep name as text; the UI must use textContent.
export function toPublicUser(row) {
  if (!row || !['id', 'email', 'name'].every(key => typeof row[key] === 'string')) throw new ApiError('INTERNAL_ERROR');
  return { id: row.id, email: row.email, name: row.name };
}
