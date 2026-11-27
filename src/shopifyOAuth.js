import crypto from 'node:crypto';
import { config, getStore } from './config.js';
import { saveOAuthTokens, getOAuthTokensRaw } from './db.js';
import { encryptSecret, decryptSecret } from './tokenCrypto.js';

/**
 * Gerencia tokens "expiring offline" da Shopify (introduzidos em dez/2025):
 * o access_token dura pouco (tipicamente 1h, informado por "expires_in" na
 * resposta) e precisa ser renovado com um refresh_token (valido por 90 dias).
 *
 * Estrategia usada aqui:
 *  1. Renovacao preguicosa: antes de qualquer chamada a Admin API, garantimos
 *     que o token atual ainda tem folga (ver ensureFreshAccessToken).
 *  2. Renovacao proativa: agendamos um timer para renovar um pouco antes do
 *     vencimento real, para nunca depender de uma requisicao chegar bem na hora.
 *  3. Rotina diaria as 03:00 (pedida explicitamente): renova todas as lojas
 *     OAuth como camada extra de seguranca contra falhas dos timers acima.
 *
 * O access_token dura muito menos que 24h, entao os itens 1 e 2 sao essenciais:
 * uma renovacao unica por dia NAO seria suficiente para manter o token valido
 * o tempo todo (ele expiraria entre uma execucao e outra da rotina das 3h).
 */

const DEFAULT_SCOPES = ['read_customers', 'write_customers'];
const REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000; // renova 5 min antes do vencimento
const DAILY_REFRESH_HOUR = 3; // 03:00, horario do servidor
const MAX_REFRESH_RETRIES = 4;
const TOKEN_REQUEST_TIMEOUT_MS = 15000; // sem limite, uma conexao travada prende a renovacao da loja para sempre

const memoryCache = new Map(); // storeKey -> { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, scope }
const refreshTimers = new Map(); // storeKey -> Timeout
const refreshInFlight = new Map(); // storeKey -> Promise (evita corridas concorrentes)

function requireOAuthStore(store) {
  if (!store?.oauth) {
    throw new Error(`A loja "${store?.key}" nao esta configurada para OAuth.`);
  }
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Monta a URL de autorizacao (tela de consentimento) para o fluxo authorization code grant. */
export function buildAuthorizeUrl(store, state) {
  requireOAuthStore(store);
  const scope = (store.oauth.scopes || DEFAULT_SCOPES).join(',');
  const redirectUri = `${config.appUrl}/oauth/${store.key}/callback`;
  const url = new URL(`https://${store.shopDomain}/admin/oauth/authorize`);
  url.searchParams.set('client_id', store.oauth.clientId);
  url.searchParams.set('scope', scope);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Valida o HMAC do callback OAuth conforme a documentacao da Shopify: remove
 * hmac/signature, ordena os parametros restantes e compara o HMAC-SHA256
 * calculado com a client secret contra o valor recebido (tempo constante).
 */
export function verifyCallbackHmac(query, clientSecret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || typeof hmac !== 'string') return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');

  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmac, 'utf8');
  if (digestBuffer.length !== hmacBuffer.length) {
    crypto.timingSafeEqual(digestBuffer, digestBuffer);
    return false;
  }
  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

/** Confere que o parametro "shop" do callback e um dominio valido e bate com a loja esperada. */
export function isValidShopDomain(shop, expectedDomain) {
  if (!shop || typeof shop !== 'string') return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) return false;
  return shop.toLowerCase() === expectedDomain.toLowerCase();
}

function persistTokens(storeKey, tokens) {
  const record = {
    accessToken: tokens.access_token,
    accessTokenExpiresAt: nowIso(tokens.expires_in * 1000),
    refreshToken: tokens.refresh_token,
    refreshTokenExpiresAt: nowIso(tokens.refresh_token_expires_in * 1000),
    scope: tokens.scope || '',
  };

  saveOAuthTokens(storeKey, {
    accessTokenEnc: encryptSecret(record.accessToken),
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenEnc: encryptSecret(record.refreshToken),
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    scope: record.scope,
  });

  memoryCache.set(storeKey, record);
  scheduleProactiveRefresh(storeKey, record);
  return record;
}

function loadTokens(storeKey) {
  if (memoryCache.has(storeKey)) return memoryCache.get(storeKey);

  const row = getOAuthTokensRaw(storeKey);
  if (!row) return null;

  const record = {
    accessToken: decryptSecret(row.access_token_enc),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken: decryptSecret(row.refresh_token_enc),
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    scope: row.scope,
  };
  memoryCache.set(storeKey, record);
  return record;
}

async function requestToken(store, params) {
  const url = `https://${store.shopDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    client_id: store.oauth.clientId,
    client_secret: store.oauth.clientSecret,
    ...params,
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const err = new Error(`Falha de rede ao gerar/renovar token da Shopify: ${error.message}`);
    throw err;
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`Resposta invalida da Shopify ao gerar token (HTTP ${response.status}).`);
    err.httpStatus = response.status;
    throw err;
  }

  if (!response.ok) {
    const description = payload.error_description || payload.error || 'erro desconhecido';
    const err = new Error(`Shopify recusou a geracao do token: ${description}`);
    err.httpStatus = response.status;
    err.shopifyError = payload.error;
    throw err;
  }

  if (!payload.access_token || !payload.refresh_token || !payload.expires_in) {
    throw new Error(
      'A Shopify nao retornou um token expiring offline completo (access_token/refresh_token/expires_in). Confirme os escopos e se o app usa "expiring=1".',
    );
  }

  return payload;
}

/** Troca o "code" recebido no callback OAuth por um token expiring offline (uso unico, feito pelo humano). */
export async function exchangeCodeForToken(store, code) {
  requireOAuthStore(store);
  const tokens = await requestToken(store, { code, expiring: '1' });
  console.log(`[oauth] token inicial obtido para "${store.key}" (expira em ${tokens.expires_in}s).`);
  return persistTokens(store.key, tokens);
}

/** Renova o access_token de uma loja usando o refresh_token salvo. Serializado por loja. */
export async function refreshAccessToken(storeKey, attempt = 1) {
  if (refreshInFlight.has(storeKey)) {
    return refreshInFlight.get(storeKey);
  }

  const task = (async () => {
    const store = getStore(storeKey);
    if (!store) throw new Error(`Loja "${storeKey}" nao configurada.`);

    const current = loadTokens(storeKey);
    if (!current) {
      throw new Error(
        `Loja "${storeKey}" ainda nao concluiu a autorizacao OAuth (nenhum refresh_token salvo). Acesse /oauth/${storeKey}/install autenticado no painel.`,
      );
    }

    if (new Date(current.refreshTokenExpiresAt).getTime() <= Date.now()) {
      throw new Error(
        `O refresh_token da loja "${storeKey}" expirou (90 dias). Refaca a autorizacao em /oauth/${storeKey}/install.`,
      );
    }

    try {
      const tokens = await requestToken(store, {
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      const record = persistTokens(storeKey, tokens);
      console.log(`[oauth] token renovado para "${storeKey}" (expira em ${tokens.expires_in}s).`);
      return record;
    } catch (error) {
      // Erros transitorios (rede, 5xx, 429) podem ser tentados de novo com o
      // mesmo refresh_token: a Shopify garante resposta identica por ate 1h
      // apos uma renovacao interrompida. Erros definitivos (401 invalid_request)
      // exigem nova autorizacao manual e nao devem ser retentados.
      const transient = !error.httpStatus || error.httpStatus >= 500 || error.httpStatus === 429;
      if (transient && attempt < MAX_REFRESH_RETRIES) {
        const wait = Math.min(2 ** attempt * 1000, 30000);
        console.warn(
          `[oauth] falha transitoria ao renovar token de "${storeKey}" (tentativa ${attempt}/${MAX_REFRESH_RETRIES}): ${error.message}. Nova tentativa em ${wait}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        return refreshAccessToken(storeKey, attempt + 1);
      }
      console.error(`[oauth] falha ao renovar token de "${storeKey}": ${error.message}`);
      throw error;
    }
  })();

  refreshInFlight.set(storeKey, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(storeKey);
  }
}

/** Garante um access_token valido antes de cada chamada a Admin API (renovacao "preguicosa"). */
export async function ensureFreshAccessToken(store) {
  requireOAuthStore(store);
  const current = loadTokens(store.key);
  if (!current) {
    throw new Error(
      `Loja "${store.key}" ainda nao concluiu a autorizacao OAuth. Peca a um admin para acessar /oauth/${store.key}/install.`,
    );
  }

  const expiresInMs = new Date(current.accessTokenExpiresAt).getTime() - Date.now();
  if (expiresInMs > REFRESH_SAFETY_MARGIN_MS) {
    return current.accessToken;
  }

  const refreshed = await refreshAccessToken(store.key);
  return refreshed.accessToken;
}

function scheduleProactiveRefresh(storeKey, record) {
  const existing = refreshTimers.get(storeKey);
  if (existing) clearTimeout(existing);

  const delay = Math.max(
    new Date(record.accessTokenExpiresAt).getTime() - Date.now() - REFRESH_SAFETY_MARGIN_MS,
    15000,
  );
  const timer = setTimeout(() => {
    refreshAccessToken(storeKey).catch((error) => {
      console.error(`[oauth] renovacao proativa falhou para "${storeKey}": ${error.message}`);
    });
  }, delay);
  timer.unref();
  refreshTimers.set(storeKey, timer);
}

function msUntilNextRun(hour) {
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

function scheduleDailyJob() {
  const delay = msUntilNextRun(DAILY_REFRESH_HOUR);
  const timer = setTimeout(async () => {
    console.log('[oauth] rotina diaria das 03:00 iniciada.');
    for (const store of config.stores.values()) {
      if (store.authMode !== 'oauth') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await refreshAccessToken(store.key);
      } catch (error) {
        console.error(`[oauth] rotina diaria: falha ao renovar "${store.key}": ${error.message}`);
      }
    }
    scheduleDailyJob();
  }, delay);
  timer.unref();
  console.log(`[oauth] proxima rotina diaria de renovacao (03:00) em ${Math.round(delay / 60000)} min.`);
}

/**
 * Chamado uma vez, na subida do servidor: agenda a rotina fixa das 03:00 (pedida
 * explicitamente, como camada extra de seguranca) e retoma a renovacao proativa
 * para lojas que ja possuem token salvo.
 */
export function startOAuthScheduler() {
  const oauthStores = [...config.stores.values()].filter((store) => store.authMode === 'oauth');
  if (!oauthStores.length) return;

  scheduleDailyJob();

  for (const store of oauthStores) {
    const tokens = loadTokens(store.key);
    if (tokens) {
      scheduleProactiveRefresh(store.key, tokens);
    } else {
      console.warn(
        `[oauth] loja "${store.key}" configurada para OAuth mas ainda sem token salvo. Acesse /oauth/${store.key}/install (autenticado) para autorizar.`,
      );
    }
  }
}
