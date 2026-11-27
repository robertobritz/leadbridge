import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  config,
  listStoresPublic,
  getStore,
  readStoresFile,
  storesEditableViaFile,
  applyStoresUpdate,
  ConfigValidationError,
} from '../config.js';
import { checkCredentials, setSessionCookie, clearSessionCookie, requireAuth } from '../auth.js';
import { testConnection, upsertLead, ShopifyError } from '../shopify.js';
import {
  listSubmissions,
  getSubmission,
  getStats,
  getHourlyActivity,
  insertSubmission,
} from '../db.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de acesso. Aguarde 15 minutos.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { user, password } = req.body || {};
  if (!checkCredentials(user, password)) {
    return res.status(401).json({ error: 'Usuario ou senha incorretos.' });
  }
  setSessionCookie(res);
  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.use(requireAuth);

router.get('/overview', (req, res) => {
  const storeKey = req.query.store || null;
  res.json({
    stats: getStats(),
    activity: getHourlyActivity(48, storeKey),
    stores: listStoresPublic(),
    settings: {
      apiVersion: config.shopifyApiVersion,
      retentionDays: config.retentionDays,
      environment: config.nodeEnv,
      storesEditable: storesEditableViaFile(),
    },
  });
});

router.get('/submissions', (req, res) => {
  const { store, status, q, page, perPage } = req.query;
  res.json(
    listSubmissions({
      storeKey: store || null,
      status: status || null,
      search: q || null,
      page: page || 1,
      perPage: perPage || 25,
    }),
  );
});

router.get('/submissions/:id', (req, res) => {
  const submission = getSubmission(Number(req.params.id));
  if (!submission) {
    return res.status(404).json({ error: 'Registro nao encontrado.' });
  }
  return res.json(submission);
});

/** Reenvia um lead que falhou, reaproveitando os dados originais. */
router.post('/submissions/:id/retry', async (req, res) => {
  const original = getSubmission(Number(req.params.id));
  if (!original) {
    return res.status(404).json({ error: 'Registro nao encontrado.' });
  }

  const store = getStore(original.storeKey);
  if (!store) {
    return res.status(400).json({ error: `A loja "${original.storeKey}" nao esta mais configurada.` });
  }

  const lead = {
    email: original.email,
    firstName: original.firstName,
    lastName: original.lastName,
    phone: original.phone,
    tags: original.tags,
  };

  const startedAt = Date.now();
  const baseLog = {
    storeKey: store.key,
    email: lead.email,
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    tags: lead.tags,
    origin: 'painel-de-gestao',
    request: lead,
    retryOf: original.id,
  };

  try {
    const result = await upsertLead(store, lead);
    const id = insertSubmission({
      ...baseLog,
      status: 'success',
      action: result.action,
      customerId: result.customerId,
      warnings: result.warnings,
      response: { tagsApplied: result.tagsApplied, ...result.raw },
      durationMs: Date.now() - startedAt,
    });
    return res.json({ ok: true, id, action: result.action });
  } catch (error) {
    const details = error instanceof ShopifyError ? error.details : {};
    insertSubmission({
      ...baseLog,
      status: 'error',
      errorMessage: error.message,
      response: details,
      durationMs: Date.now() - startedAt,
    });
    return res.status(502).json({ error: error.message });
  }
});

/** Confere se o token da loja continua valido, sem nunca expor o token. */
router.post('/stores/:key/test', async (req, res) => {
  const store = getStore(req.params.key);
  if (!store) {
    return res.status(404).json({ error: 'Loja nao encontrada.' });
  }
  try {
    const info = await testConnection(store);
    return res.json({ ok: true, shop: info });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

/** Lista as lojas configuradas, para o painel de "Gerenciar lojas". */
router.get('/stores', (req, res) => {
  res.json({ editable: storesEditableViaFile(), stores: listStoresPublic() });
});

function parseListField(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Monta a entrada bruta (mesmo formato do stores.json) a partir do formulario do
 * painel. Quando "existing" e informado (edicao) e o campo de segredo (adminToken
 * ou oauth.clientSecret) chega vazio, mantemos o valor ja salvo em vez de apagar.
 */
function buildRawEntry(body, existing) {
  const authMode = body.authMode === 'oauth' ? 'oauth' : 'static';

  const entry = {
    key: existing ? existing.key : String(body.key || '').trim(),
    label: String(body.label || '').trim() || undefined,
    shopDomain: String(body.shopDomain || '').trim(),
    allowedOrigins: parseListField(body.allowedOrigins),
    defaultTags: parseListField(body.defaultTags),
    phoneCountryCode: String(body.phoneCountryCode || '').trim() || undefined,
    marketingConsent: body.marketingConsent === true,
  };

  if (authMode === 'oauth') {
    const clientSecret = String(body.oauth?.clientSecret || '').trim() || existing?.oauth?.clientSecret;
    entry.oauth = {
      clientId: String(body.oauth?.clientId || '').trim(),
      clientSecret,
      scopes: parseListField(body.oauth?.scopes),
    };
  } else {
    entry.adminToken = String(body.adminToken || '').trim() || existing?.adminToken;
  }

  return entry;
}

/** Cria uma loja nova, gravando direto em stores.json (sem precisar mexer em codigo). */
router.post('/stores', (req, res) => {
  if (!storesEditableViaFile()) {
    return res.status(400).json({
      error: 'As lojas sao definidas via STORES_CONFIG neste servidor. Edite a variavel de ambiente e reinicie a aplicacao.',
    });
  }

  const raw = readStoresFile();
  const key = String(req.body?.key || '').trim();
  if (raw.some((entry) => entry.key === key)) {
    return res.status(409).json({ error: `Ja existe uma loja com a key "${key}".` });
  }

  const entry = buildRawEntry({ ...req.body, key }, null);
  try {
    const stores = applyStoresUpdate([...raw, entry]);
    return res.status(201).json({ ok: true, stores });
  } catch (error) {
    if (error instanceof ConfigValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

/** Edita uma loja existente. A key nao muda: para "renomear" a key, exclua e crie de novo. */
router.put('/stores/:key', (req, res) => {
  if (!storesEditableViaFile()) {
    return res.status(400).json({
      error: 'As lojas sao definidas via STORES_CONFIG neste servidor. Edite a variavel de ambiente e reinicie a aplicacao.',
    });
  }

  const raw = readStoresFile();
  const index = raw.findIndex((entry) => entry.key === req.params.key);
  if (index === -1) {
    return res.status(404).json({ error: 'Loja nao encontrada.' });
  }

  const updated = [...raw];
  updated[index] = buildRawEntry(req.body, raw[index]);

  try {
    const stores = applyStoresUpdate(updated);
    return res.json({ ok: true, stores });
  } catch (error) {
    if (error instanceof ConfigValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

/** Remove uma loja. Nao apaga o historico de envios ja gravado, so para de aceitar novos leads. */
router.delete('/stores/:key', (req, res) => {
  if (!storesEditableViaFile()) {
    return res.status(400).json({
      error: 'As lojas sao definidas via STORES_CONFIG neste servidor. Edite a variavel de ambiente e reinicie a aplicacao.',
    });
  }

  const raw = readStoresFile();
  const filtered = raw.filter((entry) => entry.key !== req.params.key);
  if (filtered.length === raw.length) {
    return res.status(404).json({ error: 'Loja nao encontrada.' });
  }

  try {
    const stores = applyStoresUpdate(filtered);
    return res.json({ ok: true, stores });
  } catch (error) {
    if (error instanceof ConfigValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

export default router;
