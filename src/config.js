import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORES_FILE = path.join(ROOT, 'stores.json');

/** Erro de validacao de configuracao. Na subida do servidor vira um process.exit;
 *  quando lancado a partir de uma edicao feita pelo painel, vira uma resposta 400. */
export class ConfigValidationError extends Error {}

function fail(message) {
  throw new ConfigValidationError(message);
}

/**
 * As lojas podem ser configuradas de duas formas:
 *  1. Variavel de ambiente STORES_CONFIG contendo um array JSON (usar em producao).
 *  2. Arquivo stores.json na raiz do projeto (desenvolvimento local, ou editado
 *     pelo painel em /admin, botao "Gerenciar lojas").
 * O arquivo stores.json esta no .gitignore e nunca deve ser comitado.
 * Quando STORES_CONFIG esta definida ela sempre tem prioridade, e o painel nao
 * pode editar as lojas (a variavel so muda com um redeploy).
 */
export function storesEditableViaFile() {
  return !process.env.STORES_CONFIG;
}

export function readStoresFile() {
  if (!fs.existsSync(STORES_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
    if (!Array.isArray(raw)) fail('stores.json precisa conter um array.');
    return raw;
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    fail(`stores.json nao e um JSON valido: ${error.message}`);
  }
}

function writeStoresFile(raw) {
  fs.writeFileSync(STORES_FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function loadRawStores() {
  if (process.env.STORES_CONFIG) {
    try {
      return JSON.parse(process.env.STORES_CONFIG);
    } catch (error) {
      fail(`STORES_CONFIG nao e um JSON valido: ${error.message}`);
    }
  }
  return readStoresFile();
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    fail(`Origin invalido em allowedOrigins: "${value}". Use o formato https://dominio.com`);
  }
}

function buildStores(raw, oauthReady) {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('A configuracao de lojas precisa ser um array com ao menos uma loja.');
  }

  const stores = new Map();

  raw.forEach((entry, index) => {
    const position = `loja #${index + 1}${entry.key ? ` (${entry.key})` : ''}`;

    if (!entry.key || !/^[a-z0-9-]{2,40}$/.test(entry.key)) {
      fail(`${position}: "key" obrigatoria, apenas letras minusculas, numeros e hifen (ex: madesa-mx).`);
    }
    if (stores.has(entry.key)) {
      fail(`${position}: a key "${entry.key}" esta duplicada.`);
    }
    if (!entry.shopDomain || !/\.myshopify\.com$/.test(entry.shopDomain)) {
      fail(`${position}: "shopDomain" deve terminar em .myshopify.com (ex: madesa-mx.myshopify.com).`);
    }
    // Uma loja usa OU um adminToken estatico (shpat_, nunca expira) OU um bloco
    // "oauth" (client_id/client_secret do Dev Dashboard) para renovacao automatica
    // de tokens expiring offline (ver src/shopifyOAuth.js).
    let authMode = 'static';
    let oauth = null;

    if (entry.oauth) {
      const { clientId, clientSecret, scopes } = entry.oauth;
      if (!clientId || typeof clientId !== 'string') {
        fail(`${position}: "oauth.clientId" obrigatorio quando "oauth" esta configurado.`);
      }
      if (!clientSecret || !clientSecret.startsWith('shpss_')) {
        fail(`${position}: "oauth.clientSecret" ausente ou invalido (a client secret comeca com shpss_).`);
      }
      if (!oauthReady) {
        fail(
          `${position}: para usar "oauth" e preciso configurar APP_URL e TOKEN_ENCRYPTION_KEY no .env do servidor antes.`,
        );
      }
      authMode = 'oauth';
      oauth = {
        clientId,
        clientSecret,
        scopes: Array.isArray(scopes) && scopes.length ? scopes : ['read_customers', 'write_customers'],
      };
    } else if (!entry.adminToken || !entry.adminToken.startsWith('shpat_')) {
      fail(`${position}: "adminToken" ausente ou invalido (o token do custom app comeca com shpat_), ou configure "oauth" para renovacao automatica.`);
    }

    if (!Array.isArray(entry.allowedOrigins) || entry.allowedOrigins.length === 0) {
      fail(`${position}: "allowedOrigins" obrigatorio (ex: ["https://madesa.mx"]).`);
    }

    stores.set(entry.key, {
      key: entry.key,
      label: entry.label || entry.key,
      shopDomain: entry.shopDomain,
      adminToken: entry.adminToken || null,
      authMode,
      oauth,
      allowedOrigins: entry.allowedOrigins.map(normalizeOrigin),
      defaultTags: Array.isArray(entry.defaultTags) ? entry.defaultTags : [],
      // Codigo do pais usado para completar telefones sem prefixo internacional.
      phoneCountryCode: String(entry.phoneCountryCode || '').replace(/\D/g, '') || null,
      // Consentimento de marketing NAO e ativado por padrao. Ver secao de LGPD no README.
      marketingConsent: entry.marketingConsent === true,
    });
  });

  return stores;
}

const sessionSecret = process.env.SESSION_SECRET || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';

// APP_URL e TOKEN_ENCRYPTION_KEY so sao exigidas quando alguma loja usa renovacao
// automatica de token via OAuth (ver src/shopifyOAuth.js e src/routes/oauth.js).
const appUrlRaw = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
const tokenEncryptionKeyRaw = process.env.TOKEN_ENCRYPTION_KEY || '';
const appUrlValid = /^https?:\/\/.+/.test(appUrlRaw);
const tokenKeyValid = /^[0-9a-fA-F]{64}$/.test(tokenEncryptionKeyRaw);

let stores;

try {
  if (sessionSecret.length < 32) {
    fail(
      'SESSION_SECRET obrigatorio com no minimo 32 caracteres. Gere um com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  if (adminPassword.length < 12) {
    fail('ADMIN_PASSWORD obrigatorio com no minimo 12 caracteres.');
  }

  const raw = loadRawStores();
  stores = buildStores(raw, appUrlValid && tokenKeyValid);

  const needsOAuth = [...stores.values()].some((store) => store.authMode === 'oauth');
  if (needsOAuth) {
    if (!appUrlValid) {
      fail('APP_URL obrigatoria (ex: https://seu-dominio.com, sem barra no final) quando alguma loja usa "oauth".');
    }
    if (!tokenKeyValid) {
      fail(
        'TOKEN_ENCRYPTION_KEY obrigatoria (64 caracteres hex / 32 bytes) quando alguma loja usa "oauth". Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
  }
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(`\n[config] ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  // Hospedagens como Render, Railway e Fly ficam atras de proxy: mantenha TRUST_PROXY=1 nelas.
  trustProxy: process.env.TRUST_PROXY === '1',
  sessionSecret,
  adminPassword,
  adminUser: process.env.ADMIN_USER || 'admin',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'leads.db'),
  retentionDays: Number(process.env.RETENTION_DAYS || 90),
  appUrl: appUrlValid ? appUrlRaw : null,
  tokenEncryptionKey: tokenKeyValid ? Buffer.from(tokenEncryptionKeyRaw, 'hex') : null,
  stores,
  root: ROOT,
};

export function getStore(key) {
  return config.stores.get(key) || null;
}

export function listStoresPublic() {
  return [...config.stores.values()].map((store) => ({
    key: store.key,
    label: store.label,
    shopDomain: store.shopDomain,
    allowedOrigins: store.allowedOrigins,
    defaultTags: store.defaultTags,
    phoneCountryCode: store.phoneCountryCode,
    marketingConsent: store.marketingConsent,
    authMode: store.authMode,
    // clientId nao e secreto; enviado para permitir editar a loja sem reexpor a client secret.
    oauth: store.authMode === 'oauth' ? { clientId: store.oauth.clientId, scopes: store.oauth.scopes } : null,
    // O token/secret nunca sai do servidor. Enviamos apenas os 4 ultimos caracteres para conferencia visual.
    tokenHint:
      store.authMode === 'oauth'
        ? `oauth (client ...${store.oauth.clientId.slice(-4)})`
        : `shpat_...${store.adminToken.slice(-4)}`,
  }));
}

/**
 * Valida uma nova lista de lojas, grava em stores.json e recarrega config.stores
 * em memoria, sem precisar reiniciar o servidor. So funciona quando as lojas sao
 * gerenciadas via arquivo (storesEditableViaFile() === true); usado pelo painel
 * em /admin/api/stores. Lanca ConfigValidationError (com mensagem para o usuario)
 * quando a lista informada e invalida.
 */
export function applyStoresUpdate(raw) {
  if (!storesEditableViaFile()) {
    throw new ConfigValidationError(
      'As lojas deste servidor sao definidas pela variavel de ambiente STORES_CONFIG. Para alterar, atualize essa variavel na hospedagem e reinicie a aplicacao.',
    );
  }

  const newStores = buildStores(raw, appUrlValid && tokenKeyValid);
  writeStoresFile(raw);
  config.stores = newStores;
  return listStoresPublic();
}
