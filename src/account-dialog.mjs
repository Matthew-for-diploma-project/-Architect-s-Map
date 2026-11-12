import { createAccountState } from './account-state.js';

const messages = {
  email: 'Укажите почту с адресом и доменом, например name@example.ru (до 254 символов).',
  password: 'Введите пароль от 12 до 128 символов. Пробелы учитываются.',
  name: 'Укажите имя от 1 до 80 символов без управляющих символов.',
};

// Match the server's Unicode code-point policy; passwords stay unchanged.
export function accountFieldError(field, value) {
  if (typeof value !== 'string') return messages[field];
  const text = field === 'email' ? value.trim().toLowerCase() : field === 'name' ? value.trim() : value;
  const [min, max] = field === 'email' ? [3, 254] : field === 'password' ? [12, 128] : [1, 80];
  if (text.length > max * 2 || !text.isWellFormed()) return messages[field];
  const length = [...text].length;
  if (length < min || length > max) return messages[field];
  if (field === 'name' && /\p{Cc}/u.test(text)) return messages.name;
  if (field === 'email') {
    const parts = text.split('@');
    const domain = parts[1] || '';
    if (/[\s\p{Cc}]/u.test(text) || parts.length !== 2 || !parts[0]
        || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return messages.email;
  }
  return '';
}

export function initAccountDialog() {
  const account = createAccountState();
  const dialog = document.getElementById('accountDialog');
  const opener = document.getElementById('accountBtn');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const forms = [...dialog.querySelectorAll('form')];
  const name = document.getElementById('registerName');
  const preview = document.getElementById('accountNamePreview');
  const nameText = document.getElementById('accountNameText');
  const accountName = document.getElementById('accountName');
  const logout = document.getElementById('logoutBtn');
  const notice = document.getElementById('accountNotice');
  const retry = document.getElementById('accountRetry');
  let mode = 'login';
  let returnFocus = opener;
  let viewAttempt = 0;

  function showFailure(form, error) {
    const status = form.querySelector('[role="status"]');
    status.textContent = error.message;
    let first;
    for (const input of form.querySelectorAll('input')) {
      if (!error.fields?.[input.name]) continue;
      input.setAttribute('aria-invalid', 'true');
      document.getElementById(`${input.id}Error`).textContent = error.fields[input.name];
      first ??= input;
    }
    (first || (retry.hidden ? status : retry)).focus();
  }

  function clearFeedback(form) {
    form.querySelector('[role="status"]').textContent = '';
    for (const input of form.querySelectorAll('input')) {
      input.removeAttribute('aria-invalid');
      document.getElementById(`${input.id}Error`).textContent = '';
    }
  }

  function selectMode(nextMode) {
    viewAttempt++;
    mode = nextMode;
    document.getElementById('accountTitle').textContent = mode === 'login' ? 'Вход в ГеоКонтекст' : 'Регистрация';
    for (const tab of tabs) {
      const selected = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    for (const form of forms) {
      form.elements.password.value = '';
      clearFeedback(form);
    }
  }

  opener.addEventListener('click', () => {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    selectMode('login');
    dialog.showModal();
    (retry.hidden ? forms[0].elements.email : retry).focus();
  });
  document.getElementById('closeAccount').addEventListener('click', () => dialog.close());
  // Native modal dialogs make the map/drawer inert and handle Escape.
  dialog.addEventListener('close', () => {
    viewAttempt++;
    for (const form of forms) { form.reset(); clearFeedback(form); }
    nameText.textContent = '';
    preview.hidden = true;
    const target = returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : logout.hidden ? opener : logout;
    target.focus();
  });

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      if (account.getState().phase !== 'guest' || account.getState().pending) return;
      const email = forms.find(form => !form.parentElement.hidden).elements.email.value;
      selectMode(tab.dataset.mode);
      forms.find(form => !form.parentElement.hidden).elements.email.value = email;
    });
    tab.addEventListener('keydown', event => {
      if (tab.disabled) return;
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  }

  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  name.addEventListener('input', () => {
    const valid = !accountFieldError('name', name.value);
    // User-provided names are always text, including markup-shaped names.
    nameText.textContent = valid ? name.value.trim() : '';
    preview.hidden = !valid;
  });

  for (const form of forms) {
    form.addEventListener('input', event => {
      const input = event.target;
      if (!input.matches('input')) return;
      input.removeAttribute('aria-invalid');
      document.getElementById(`${input.id}Error`).textContent = '';
      form.querySelector('[role="status"]').textContent = '';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (account.getState().phase !== 'guest' || account.getState().pending) return;
      clearFeedback(form);
      let firstInvalid;
      for (const input of form.querySelectorAll('input')) {
        const message = accountFieldError(input.name, input.value);
        document.getElementById(`${input.id}Error`).textContent = message;
        if (message) { input.setAttribute('aria-invalid', 'true'); firstInvalid ??= input; }
        else input.removeAttribute('aria-invalid');
      }
      const status = form.querySelector('[role="status"]');
      if (firstInvalid) {
        status.textContent = 'Проверьте отмеченные поля.';
        firstInvalid.focus();
        return;
      }
      const attempt = ++viewAttempt;
      const data = Object.fromEntries([...form.querySelectorAll('input')].map(input => [input.name, input.value]));
      status.textContent = mode === 'login' ? 'Выполняем вход…' : 'Создаём аккаунт…';
      const request = account.authenticate(mode, data);
      // The request body is already constructed. Do not retain the password in
      // a closed or retried form while the request is in flight.
      for (const item of forms) item.elements.password.value = '';
      delete data.password;
      try { await request; }
      catch (error) { if (dialog.open && attempt === viewAttempt) showFailure(form, error); }
    });
  }

  async function refresh() {
    try {
      await account.refresh();
      if (dialog.open && account.getState().phase === 'guest') {
        forms.find(form => !form.parentElement.hidden).elements.email.focus();
      }
    } catch { /* State supplies the retry message. */ }
  }
  retry.addEventListener('click', refresh);
  logout.addEventListener('click', async () => {
    if (account.getState().phase !== 'authenticated' || account.getState().pending) return;
    try { await account.logout(); }
    catch {
      // Logout is not assumed successful after a failed or lost response.
      if (!dialog.open) opener.click();
      retry.focus();
    }
    if (!dialog.open && account.getState().phase === 'guest') opener.focus();
  });
  account.subscribe(state => {
    document.documentElement.dataset.accountPhase = state.phase;
    const disabled = state.phase !== 'guest' || Boolean(state.pending);
    for (const form of forms) {
      form.setAttribute('aria-busy', String(Boolean(state.pending)));
      for (const input of form.querySelectorAll('input, button')) input.disabled = disabled;
    }
    for (const tab of tabs) tab.disabled = disabled;
    const hasUser = Boolean(state.user);
    accountName.hidden = !hasUser;
    accountName.textContent = state.user?.name || '';
    accountName.title = state.user?.name || '';
    logout.hidden = !hasUser;
    logout.disabled = Boolean(state.pending);
    logout.textContent = state.pending === 'logout' ? 'Выходим…' : 'Выйти';
    opener.hidden = hasUser;
    opener.disabled = state.phase === 'loading';
    opener.textContent = state.phase === 'error' ? 'Проверить вход' : state.phase === 'loading' ? 'Проверка…' : 'Войти';
    notice.textContent = state.phase === 'error' ? state.error : state.phase === 'loading'
      ? state.pending === 'register' ? 'Создаём аккаунт…' : state.pending === 'login' ? 'Выполняем вход…' : 'Проверяем состояние аккаунта…'
      : 'Войдите в свой аккаунт или создайте новый.';
    retry.hidden = state.phase !== 'error';
    retry.disabled = Boolean(state.pending);
    if (state.phase === 'authenticated' && dialog.open) dialog.close();
  });
  void refresh();
  return account;
}
