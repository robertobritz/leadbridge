const state = {
  page: 1,
  store: '',
  status: '',
  search: '',
  pages: 1,
  currentId: null,
  stores: [],
};

const el = (id) => document.getElementById(id);

const STATUS_LABEL = {
  success: 'Gravado',
  error: 'Falha',
  skipped: 'Ignorado',
};

const ACTION_LABEL = {
  created: 'Contato criado',
  updated: 'Contato atualizado',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

function formatHour(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' });
}

function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(node.dataset.timer);
  node.dataset.timer = setTimeout(() => node.classList.remove('show'), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (response.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Sessão expirada.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Falha na requisição.');
  return data;
}

/* ---------- Resumo, faixa de atividade e lojas ---------- */

function renderTiles(stats) {
  const { last24h, totals } = stats;
  const successRate = totals.total ? Math.round((totals.success / totals.total) * 100) : null;

  const tiles = [
    {
      label: 'Gravados nas últimas 24h',
      value: last24h.success,
      note: last24h.error ? `${last24h.error} falha(s) no mesmo período` : 'Nenhuma falha no período',
      alert: last24h.error > 0,
    },
    {
      label: 'Total gravado',
      value: totals.success,
      note: successRate === null ? 'Aguardando o primeiro envio' : `${successRate}% dos envios concluídos`,
    },
    {
      label: 'Falhas acumuladas',
      value: totals.error,
      note: stats.lastError ? `Última em ${formatDateTime(stats.lastError.createdAt)}` : 'Nenhuma falha registrada',
      alert: totals.error > 0,
    },
    {
      label: 'Último envio',
      value: stats.lastSuccess ? '✓' : '—',
      note: stats.lastSuccess
        ? `${stats.lastSuccess.storeKey} · ${formatDateTime(stats.lastSuccess.createdAt)}`
        : 'Nada recebido ainda',
    },
  ];

  el('tiles').innerHTML = tiles
    .map(
      (tile) => `
      <div class="tile ${tile.alert ? 'is-alert' : ''}">
        <div class="eyebrow">${escapeHtml(tile.label)}</div>
        <div class="tile-value">${escapeHtml(tile.value)}</div>
        <div class="tile-note">${escapeHtml(tile.note)}</div>
      </div>`,
    )
    .join('');
}

function renderStrip(activity) {
  const peak = Math.max(1, ...activity.map((bucket) => bucket.success + bucket.error));

  el('strip').innerHTML = activity
    .map((bucket) => {
      const total = bucket.success + bucket.error;
      const height = total ? Math.max(6, Math.round((total / peak) * 68)) : 0;
      const errHeight = total ? Math.round((bucket.error / total) * height) : 0;
      const okHeight = height - errHeight;
      const tip = total
        ? `${formatHour(bucket.hour)}h · ${bucket.success} ok · ${bucket.error} falha`
        : `${formatHour(bucket.hour)}h · sem envios`;

      return `
        <div class="strip-col ${total ? 'has-data' : ''}">
          <span class="strip-tip">${escapeHtml(tip)}</span>
          ${errHeight ? `<div class="strip-bar-err" style="height:${errHeight}px"></div>` : ''}
          ${okHeight ? `<div class="strip-bar-ok" style="height:${okHeight}px"></div>` : ''}
        </div>`;
    })
    .join('');

  if (activity.length) {
    el('strip-start').textContent = `${formatHour(activity[0].hour)}h`;
    el('strip-end').textContent = 'agora';
  }
}

function renderStores(stores, perStore) {
  const statsByStore = new Map(perStore.map((row) => [row.storeKey, row]));

  el('stores').innerHTML = stores
    .map((store) => {
      const stats = statsByStore.get(store.key);
      const consent = store.marketingConsent ? 'Ativado' : 'Desativado';
      return `
        <div class="card store" data-store="${escapeHtml(store.key)}">
          <div class="store-title">
            ${escapeHtml(store.label)}
            <span class="badge badge-plain">${escapeHtml(store.key)}</span>
          </div>
          <dl class="store-rows">
            <dt>Domínio</dt><dd>${escapeHtml(store.shopDomain)}</dd>
            <dt>Origens</dt><dd>${escapeHtml(store.allowedOrigins.join(', '))}</dd>
            <dt>Tags fixas</dt><dd>${escapeHtml(store.defaultTags.join(', ') || '—')}</dd>
            <dt>Token</dt><dd>${escapeHtml(store.tokenHint)}</dd>
            <dt>Opt-in e-mail</dt><dd>${escapeHtml(consent)}</dd>
            <dt>7 dias</dt><dd>${stats ? `${stats.success} ok · ${stats.error} falha` : 'sem envios'}</dd>
          </dl>
          <div class="store-foot">
            <button type="button" class="btn btn-ghost" data-test="${escapeHtml(store.key)}">Testar conexão</button>
            <span class="store-test-result" data-result="${escapeHtml(store.key)}"></span>
          </div>
        </div>`;
    })
    .join('');

  document.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', () => testStore(button.dataset.test, button));
  });
}

async function testStore(key, button) {
  const result = document.querySelector(`[data-result="${key}"]`);
  button.disabled = true;
  result.textContent = 'testando…';
  result.style.color = 'var(--slate)';

  try {
    const data = await api(`/admin/api/stores/${encodeURIComponent(key)}/test`, { method: 'POST' });
    result.textContent = `✓ ${data.shop.name} (API ${data.shop.apiVersion})`;
    result.style.color = 'var(--ok)';
  } catch (error) {
    result.textContent = `✕ ${error.message}`;
    result.style.color = 'var(--err)';
  } finally {
    button.disabled = false;
  }
}

/* ---------- Histórico ---------- */

function renderRows(data) {
  state.pages = data.pages;

  if (!data.items.length) {
    el('rows').innerHTML = '';
    el('table-empty').innerHTML = `
      <div class="empty">
        <h3>Nenhum envio por aqui</h3>
        <p>${
          state.search || state.status || state.store
            ? 'Ajuste os filtros para ver outros registros.'
            : 'Assim que o popup enviar o primeiro lead, ele aparece nesta lista.'
        }</p>
      </div>`;
  } else {
    el('table-empty').innerHTML = '';
    el('rows').innerHTML = data.items
      .map((item) => {
        const name = [item.firstName, item.lastName].filter(Boolean).join(' ');
        const warnMark = item.warnings?.length ? ' <span class="badge badge-skipped">aviso</span>' : '';
        return `
          <tr tabindex="0" data-id="${item.id}">
            <td>
              <div class="cell-email">${escapeHtml(item.email)}</div>
              ${name ? `<div class="cell-name">${escapeHtml(name)}</div>` : ''}
            </td>
            <td><span class="badge badge-plain">${escapeHtml(item.storeKey)}</span></td>
            <td><span class="badge badge-${escapeHtml(item.status)}">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span>${warnMark}</td>
            <td class="cell-when">${escapeHtml(ACTION_LABEL[item.action] || '—')}</td>
            <td class="cell-when">${escapeHtml(formatDateTime(item.createdAt))}</td>
          </tr>`;
      })
      .join('');

    document.querySelectorAll('#rows tr').forEach((row) => {
      const open = () => openDrawer(Number(row.dataset.id));
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    });
  }

  el('pager-info').textContent = data.total
    ? `${data.total} registro(s) · página ${data.page} de ${data.pages}`
    : 'Nenhum registro';
  el('prev').disabled = data.page <= 1;
  el('next').disabled = data.page >= data.pages;
}

/* ---------- Detalhe ---------- */

async function openDrawer(id) {
  state.currentId = id;
  el('drawer').classList.add('open');
  el('drawer-backdrop').classList.add('open');
  el('drawer-body').innerHTML = '<p class="mono" style="color:var(--slate)">Carregando…</p>';
  el('retry-note').textContent = '';

  try {
    const item = await api(`/admin/api/submissions/${id}`);
    el('drawer-title').textContent = `Envio #${item.id}`;
    el('retry').disabled = false;

    const name = [item.firstName, item.lastName].filter(Boolean).join(' ') || '—';
    const customerId = item.customerId ? item.customerId.split('/').pop() : null;
    const storeConfig = state.stores.find((store) => store.key === item.storeKey);
    const adminLink =
      customerId && storeConfig
        ? `<a href="https://${escapeHtml(storeConfig.shopDomain)}/admin/customers/${escapeHtml(customerId)}" target="_blank" rel="noopener">Abrir na Shopify ↗</a>`
        : '—';

    const notes = [];
    if (item.errorMessage) {
      notes.push(`<div class="note note-error"><strong>Falhou:</strong> ${escapeHtml(item.errorMessage)}</div>`);
    }
    (item.warnings || []).forEach((warning) => {
      notes.push(`<div class="note note-warn">${escapeHtml(warning)}</div>`);
    });

    el('drawer-body').innerHTML = `
      ${notes.join('')}
      <dl class="detail-rows">
        <dt>Resultado</dt><dd><span class="badge badge-${escapeHtml(item.status)}">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span></dd>
        <dt>E-mail</dt><dd class="mono">${escapeHtml(item.email)}</dd>
        <dt>Nome</dt><dd>${escapeHtml(name)}</dd>
        <dt>Telefone</dt><dd class="mono">${escapeHtml(item.phone || '—')}</dd>
        <dt>Tags</dt><dd class="mono">${escapeHtml((item.tags || []).join(', ') || '—')}</dd>
        <dt>Loja</dt><dd class="mono">${escapeHtml(item.storeKey)}</dd>
        <dt>Ação</dt><dd>${escapeHtml(ACTION_LABEL[item.action] || '—')}</dd>
        <dt>Contato</dt><dd>${adminLink}</dd>
        <dt>Origem</dt><dd class="mono">${escapeHtml(item.origin || '—')}</dd>
        <dt>Duração</dt><dd class="mono">${item.durationMs != null ? `${item.durationMs} ms` : '—'}</dd>
        <dt>Recebido em</dt><dd class="mono">${escapeHtml(formatDateTime(item.createdAt))}</dd>
        ${item.retryOf ? `<dt>Reenvio de</dt><dd class="mono">#${item.retryOf}</dd>` : ''}
      </dl>

      <div class="eyebrow" style="margin-bottom:6px">Dados recebidos do popup</div>
      <pre>${escapeHtml(JSON.stringify(item.request, null, 2))}</pre>

      <div class="eyebrow" style="margin-bottom:6px">Resposta da Shopify</div>
      <pre>${escapeHtml(JSON.stringify(item.response, null, 2))}</pre>
    `;
  } catch (error) {
    el('drawer-body').innerHTML = `<div class="note note-error">${escapeHtml(error.message)}</div>`;
    el('retry').disabled = true;
  }
}

function closeDrawer() {
  el('drawer').classList.remove('open');
  el('drawer-backdrop').classList.remove('open');
  state.currentId = null;
}

/* ---------- Carregamento ---------- */

async function loadOverview() {
  const data = await api(`/admin/api/overview${state.store ? `?store=${encodeURIComponent(state.store)}` : ''}`);
  state.stores = data.stores;
  state.storesEditable = data.settings.storesEditable;

  const filter = el('store-filter');
  const currentValue = filter.value;
  filter.innerHTML = '<option value="">Todas as lojas</option>';
  data.stores.forEach((store) => {
    const option = document.createElement('option');
    option.value = store.key;
    option.textContent = store.label;
    filter.appendChild(option);
  });
  if (data.stores.some((store) => store.key === currentValue)) {
    filter.value = currentValue;
  } else if (state.store) {
    state.store = '';
  }

  el('meta-version').textContent = `API ${data.settings.apiVersion} · histórico ${data.settings.retentionDays}d`;

  renderTiles(data.stats);
  renderStrip(data.activity);
  renderStores(data.stores, data.stats.perStore);
}

async function loadSubmissions() {
  const params = new URLSearchParams({ page: state.page, perPage: 25 });
  if (state.store) params.set('store', state.store);
  if (state.status) params.set('status', state.status);
  if (state.search) params.set('q', state.search);
  renderRows(await api(`/admin/api/submissions?${params.toString()}`));
}

async function refresh() {
  try {
    await Promise.all([loadOverview(), loadSubmissions()]);
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------- Eventos ---------- */

el('store-filter').addEventListener('change', (event) => {
  state.store = event.target.value;
  state.page = 1;
  refresh();
});

el('status-filter').addEventListener('change', (event) => {
  state.status = event.target.value;
  state.page = 1;
  loadSubmissions().catch((error) => toast(error.message, true));
});

let searchTimer;
el('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = event.target.value.trim();
    state.page = 1;
    loadSubmissions().catch((error) => toast(error.message, true));
  }, 320);
});

el('prev').addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    loadSubmissions().catch((error) => toast(error.message, true));
  }
});

el('next').addEventListener('click', () => {
  if (state.page < state.pages) {
    state.page += 1;
    loadSubmissions().catch((error) => toast(error.message, true));
  }
});

el('refresh').addEventListener('click', refresh);

el('logout').addEventListener('click', async () => {
  await fetch('/admin/api/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

el('drawer-close').addEventListener('click', closeDrawer);
el('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});

el('retry').addEventListener('click', async () => {
  if (!state.currentId) return;
  const button = el('retry');
  button.disabled = true;
  el('retry-note').textContent = 'enviando…';

  try {
    const data = await api(`/admin/api/submissions/${state.currentId}/retry`, { method: 'POST' });
    el('retry-note').textContent = '';
    toast(data.action === 'created' ? 'Contato criado na Shopify.' : 'Contato atualizado na Shopify.');
    closeDrawer();
    refresh();
  } catch (error) {
    el('retry-note').textContent = '';
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

refresh();
setInterval(refresh, 60000);
