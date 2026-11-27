const storeModalState = {
  editingKey: null,
};

function openStoreModal() {
  el('store-modal').classList.add('open');
  el('store-modal-backdrop').classList.add('open');
  hideStoreForm();
  renderStoreList();
}

function closeStoreModal() {
  el('store-modal').classList.remove('open');
  el('store-modal-backdrop').classList.remove('open');
}

function renderStoreList() {
  const editable = state.storesEditable !== false;
  el('store-modal-readonly-note').style.display = editable ? 'none' : 'block';
  el('store-add-new').style.display = editable ? '' : 'none';

  el('store-list').innerHTML = state.stores
    .map((store) => {
      const authLabel = store.authMode === 'oauth' ? 'OAuth (renovação automática)' : 'Token fixo';
      const oauthLink =
        store.authMode === 'oauth'
          ? `<a href="/oauth/${encodeURIComponent(store.key)}/install" target="_blank" rel="noopener" class="btn-link">Autorizar OAuth ↗</a>`
          : '';
      const actions = editable
        ? `<button type="button" class="btn-link" data-store-edit="${escapeHtml(store.key)}">Editar</button>
           <button type="button" class="btn-link" data-store-delete="${escapeHtml(store.key)}">Excluir</button>`
        : '';

      return `
        <div class="card store-list-item">
          <div class="store-list-item-head">
            <strong>${escapeHtml(store.label)}</strong>
            <span class="badge badge-plain">${escapeHtml(store.key)}</span>
            <span class="filler"></span>
            ${actions}
          </div>
          <div class="mono store-list-item-meta">${escapeHtml(store.shopDomain)} · ${escapeHtml(authLabel)} · ${escapeHtml(store.tokenHint)}</div>
          ${oauthLink}
        </div>`;
    })
    .join('');

  document.querySelectorAll('[data-store-edit]').forEach((button) => {
    button.addEventListener('click', () => editStore(button.dataset.storeEdit));
  });
  document.querySelectorAll('[data-store-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteStore(button.dataset.storeDelete));
  });
}

function hideStoreForm() {
  storeModalState.editingKey = null;
  el('store-form').reset();
  el('store-form').style.display = 'none';
  el('sf-error').style.display = 'none';
  el('sf-key').disabled = false;
}

function showStoreForm() {
  el('store-form').style.display = 'block';
  el('sf-error').style.display = 'none';
}

function setAuthModeFields() {
  const isOauth = el('sf-authmode').value === 'oauth';
  el('sf-static-fields').style.display = isOauth ? 'none' : '';
  el('sf-oauth-fields').style.display = isOauth ? '' : 'none';
}

function addNewStore() {
  hideStoreForm();
  showStoreForm();
  el('sf-authmode').value = 'static';
  setAuthModeFields();
}

function editStore(key) {
  const store = state.stores.find((item) => item.key === key);
  if (!store) return;

  hideStoreForm();
  showStoreForm();
  storeModalState.editingKey = key;

  el('sf-key').value = store.key;
  el('sf-key').disabled = true;
  el('sf-label').value = store.label;
  el('sf-domain').value = store.shopDomain;
  el('sf-authmode').value = store.authMode;
  el('sf-origins').value = store.allowedOrigins.join('\n');
  el('sf-tags').value = store.defaultTags.join('\n');
  el('sf-phone').value = store.phoneCountryCode || '';
  el('sf-consent').checked = store.marketingConsent;
  el('sf-token').value = '';
  el('sf-client-id').value = store.oauth?.clientId || '';
  el('sf-client-secret').value = '';
  el('sf-scopes').value = (store.oauth?.scopes || []).join('\n');
  el('sf-token-hint').textContent =
    store.authMode === 'static' ? `Token atual: ${store.tokenHint} — deixe em branco para manter.` : '';
  el('sf-secret-hint').textContent =
    store.authMode === 'oauth' ? 'Client secret já salva — deixe em branco para manter.' : '';

  setAuthModeFields();
}

async function deleteStore(key) {
  if (!confirm(`Excluir a loja "${key}"? Ela para de receber novos leads. O histórico já gravado não é apagado.`)) {
    return;
  }

  try {
    const data = await api(`/admin/api/stores/${encodeURIComponent(key)}`, { method: 'DELETE' });
    state.stores = data.stores;
    renderStoreList();
    toast('Loja removida.');
    refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

el('manage-stores-btn').addEventListener('click', openStoreModal);
el('store-modal-close').addEventListener('click', closeStoreModal);
el('store-modal-backdrop').addEventListener('click', closeStoreModal);
el('store-add-new').addEventListener('click', addNewStore);
el('sf-cancel').addEventListener('click', hideStoreForm);
el('sf-authmode').addEventListener('change', setAuthModeFields);

el('store-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const authMode = el('sf-authmode').value;
  const payload = {
    label: el('sf-label').value.trim(),
    shopDomain: el('sf-domain').value.trim(),
    authMode,
    allowedOrigins: el('sf-origins').value,
    defaultTags: el('sf-tags').value,
    phoneCountryCode: el('sf-phone').value.trim(),
    marketingConsent: el('sf-consent').checked,
  };

  if (authMode === 'oauth') {
    payload.oauth = {
      clientId: el('sf-client-id').value.trim(),
      clientSecret: el('sf-client-secret').value.trim(),
      scopes: el('sf-scopes').value,
    };
  } else {
    payload.adminToken = el('sf-token').value.trim();
  }

  const editingKey = storeModalState.editingKey;
  const button = el('sf-save');
  button.disabled = true;

  try {
    let data;
    if (editingKey) {
      data = await api(`/admin/api/stores/${encodeURIComponent(editingKey)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      payload.key = el('sf-key').value.trim();
      data = await api('/admin/api/stores', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    state.stores = data.stores;
    hideStoreForm();
    renderStoreList();
    toast(editingKey ? 'Loja atualizada.' : 'Loja criada.');
    refresh();
  } catch (error) {
    const box = el('sf-error');
    box.textContent = error.message;
    box.style.display = 'block';
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeStoreModal();
});
