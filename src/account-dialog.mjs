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
  const dialog = document.getElementById('accountDialog');
  const opener = document.getElementById('accountBtn');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const forms = [...dialog.querySelectorAll('form')];
  const name = document.getElementById('registerName');
  const preview = document.getElementById('accountNamePreview');
  const nameText = document.getElementById('accountNameText');
  let mode = 'login';
  let returnFocus = opener;

  function clearFeedback(form) {
    form.querySelector('[role="status"]').textContent = '';
    for (const input of form.querySelectorAll('input')) {
      input.removeAttribute('aria-invalid');
      document.getElementById(`${input.id}Error`).textContent = '';
    }
  }

  function selectMode(nextMode) {
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
    forms[0].elements.email.focus();
  });
  document.getElementById('closeAccount').addEventListener('click', () => dialog.close());
  // Native modal dialogs make the map/drawer inert and handle Escape.
  dialog.addEventListener('close', () => {
    for (const form of forms) { form.reset(); clearFeedback(form); }
    nameText.textContent = '';
    preview.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus();
  });

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const email = forms.find(form => !form.parentElement.hidden).elements.email.value;
      selectMode(tab.dataset.mode);
      forms.find(form => !form.parentElement.hidden).elements.email.value = email;
    });
    tab.addEventListener('keydown', event => {
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
    form.addEventListener('submit', event => {
      // P13 is the dialog only. Never navigate with credentials or simulate login.
      event.preventDefault();
      let firstInvalid;
      for (const input of form.querySelectorAll('input')) {
        const message = accountFieldError(input.name, input.value);
        document.getElementById(`${input.id}Error`).textContent = message;
        if (message) { input.setAttribute('aria-invalid', 'true'); firstInvalid ??= input; }
        else input.removeAttribute('aria-invalid');
      }
      const status = form.querySelector('[role="status"]');
      status.textContent = firstInvalid ? 'Проверьте отмеченные поля.'
        : 'Вход и регистрация пока недоступны. Данные не отправлены.';
      firstInvalid?.focus();
    });
  }
  opener.disabled = false;
}
