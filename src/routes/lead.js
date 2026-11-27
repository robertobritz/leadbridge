import express from 'express';
import rateLimit from 'express-rate-limit';
import { config, getStore } from '../config.js';
import { upsertLead, ShopifyError } from '../shopify.js';
import { insertSubmission, hashIp, hasRecentSuccess } from '../db.js';

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Este endpoint e publico por natureza: o JavaScript do tema roda no navegador do
 * visitante, entao nao existe segredo que possa ser guardado no cliente.
 * A protecao vem de: allowlist de Origin por loja, limite de requisicoes por IP,
 * limite de tamanho do corpo e validacao estrita dos campos.
 */
const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' },
});

function resolveOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin.toLowerCase();

  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function applyCors(res, origin) {
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Vary', 'Origin');
}

function trimField(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/** Todos os origins autorizados, de todas as lojas configuradas atualmente. */
function allKnownOrigins() {
  return [...config.stores.values()].flatMap((store) => store.allowedOrigins);
}

router.options('/lead', (req, res) => {
  const origin = resolveOrigin(req);
  if (origin && allKnownOrigins().includes(origin)) {
    applyCors(res, origin);
    return res.status(204).end();
  }
  return res.status(403).end();
});

router.post('/lead', leadLimiter, async (req, res) => {
  const startedAt = Date.now();
  const origin = resolveOrigin(req);
  const body = req.body || {};

  const storeKey = trimField(body.storeKey, 40);
  const store = getStore(storeKey);

  if (!store) {
    return res.status(400).json({ error: 'Loja nao reconhecida.' });
  }

  if (!origin || !store.allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origem nao autorizada para esta loja.' });
  }

  applyCors(res, origin);

  // Campo isca: navegadores reais nao preenchem, bots automatizados costumam preencher.
  if (trimField(body.website, 200)) {
    return res.status(202).json({ ok: true });
  }

  const email = trimField(body.email, 200).toLowerCase();
  const firstName = trimField(body.firstName, 100);
  const lastName = trimField(body.lastName, 100);
  const phone = trimField(body.phone, 40);
  const rawTags = Array.isArray(body.tags) ? body.tags : [];
  const tags = rawTags.map((tag) => trimField(tag, 60)).filter(Boolean).slice(0, 10);

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(422).json({ error: 'E-mail invalido.' });
  }

  const ipHash = hashIp(req.ip);
  const baseLog = {
    storeKey: store.key,
    email,
    firstName,
    lastName,
    phone,
    tags,
    origin,
    ipHash,
    request: { email, firstName, lastName, phone, tags, storeKey: store.key },
  };

  if (hasRecentSuccess(store.key, email, 60)) {
    insertSubmission({
      ...baseLog,
      status: 'skipped',
      warnings: ['Envio duplicado ignorado: este e-mail foi processado com sucesso nos ultimos 60 segundos.'],
      durationMs: Date.now() - startedAt,
    });
    return res.status(202).json({ ok: true, duplicated: true });
  }

  try {
    const result = await upsertLead(store, { email, firstName, lastName, phone, tags });

    insertSubmission({
      ...baseLog,
      status: 'success',
      action: result.action,
      customerId: result.customerId,
      warnings: result.warnings,
      response: { tagsApplied: result.tagsApplied, ...result.raw },
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json({ ok: true, action: result.action });
  } catch (error) {
    const isShopifyError = error instanceof ShopifyError;

    insertSubmission({
      ...baseLog,
      status: 'error',
      errorMessage: error.message,
      response: isShopifyError ? error.details : {},
      durationMs: Date.now() - startedAt,
    });

    console.error(`[lead] falha na loja ${store.key}: ${error.message}`);

    // A mensagem detalhada fica no historico do painel, nao na resposta publica.
    return res.status(502).json({ error: 'Nao foi possivel registrar o contato agora.' });
  }
});

export default router;
