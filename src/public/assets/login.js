const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submitButton = document.getElementById('submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.remove('show');
  submitButton.disabled = true;
  submitButton.textContent = 'Entrando';

  try {
    const response = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: document.getElementById('user').value,
        password: document.getElementById('password').value,
      }),
    });

    if (response.ok) {
      window.location.href = '/admin';
      return;
    }

    const data = await response.json().catch(() => ({}));
    errorBox.textContent = data.error || 'Não foi possível entrar.';
    errorBox.classList.add('show');
  } catch {
    errorBox.textContent = 'O servidor não respondeu. Verifique se a aplicação está no ar.';
    errorBox.classList.add('show');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Entrar';
  }
});
