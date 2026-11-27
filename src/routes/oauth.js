import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config, getStore } from '../config.js';
import { requireAuth } from '../auth.js';
import { buildAuthorizeUrl, verifyCallbackHmac, isValidShopDomain, exchangeCodeForToken } from '../shopifyOAuth.js';

const router = express.Router();
const STATE_COOKIE_PREFIX = 'slb_oauth_state_';

const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

function signState(state) {
  return crypto.createHmac('sha256', config.sessionSecret).update(state).digest('base64url');
}

/**
 * Inicia o consentimento OAuth (autorizacao "authorization code grant"). So um
 * admin autenticado no painel pode disparar isso. E preciso fazer esse passo
 * manualmente (uma unica vez, ou sempre que o refresh_token expirar/for revogado):
 * o restante (renovacao do access_token) e automatico depois disso.
 */
router.get('/:key/install', requireAuth, (req, res) => {
  const store = getStore(req.params.key);
  if (!store || store.authMode !== 'oauth') {
    return res.status(404).send('Loja nao configurada para OAuth.');
  }

  const state = crypto.randomBytes(24).toString('base64url');
  res.cookie(`${STATE_COOKIE_PREFIX}${store.key}`, `${state}.${signState(state)}`, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: `/oauth/${store.key}`,
  });

  return res.redirect(buildAuthorizeUrl(store, state));
});

/** Callback publico: a Shopify redireciona o navegador do merchant para ca com o "code". */
router.get('/:key/callback', callbackLimiter, async (req, res) => {
  const store = getStore(req.params.key);
  if (!store || store.authMode !== 'oauth') {
    return res.status(404).send('Loja nao configurada para OAuth.');
  }

  const { shop, code, state } = req.query;

  if (!isValidShopDomain(shop, store.shopDomain)) {
    return res.status(400).send('Parametro "shop" invalido.');
  }

  const cookieName = `${STATE_COOKIE_PREFIX}${store.key}`;
  const cookieValue = req.cookies?.[cookieName] || '';
  const [rawState, rawSignature] = cookieValue.split('.');
  res.clearCookie(cookieName, { path: `/oauth/${store.key}` });

  const stateValid = Boolean(rawState) && Boolean(rawSignature) && state === rawState;
  let signatureValid = false;
  if (stateValid) {
    const expectedSignature = signState(rawState);
    const expectedBuffer = Buffer.from(expectedSignature);
    const providedBuffer = Buffer.from(rawSignature);
    signatureValid =
      expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  if (!stateValid || !signatureValid) {
    return res.status(400).send('Estado OAuth invalido ou expirado. Inicie a autorizacao novamente pelo painel.');
  }

  if (!verifyCallbackHmac(req.query, store.oauth.clientSecret)) {
    return res.status(400).send('Assinatura HMAC invalida.');
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Codigo de autorizacao ausente.');
  }

  try {
    await exchangeCodeForToken(store, code);
    return res.redirect('/admin?oauth=ok');
  } catch (error) {
    console.error(`[oauth] falha na troca do codigo por token ("${store.key}"): ${error.message}`);
    return res.status(502).send('Falha ao concluir a autorizacao com a Shopify. Veja os logs do servidor.');
  }
});

export default router;
