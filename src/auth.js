import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'slb_session';

function timingSafeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) {
    // Compara contra si mesmo para manter o tempo constante e ainda retornar falso.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function checkCredentials(user, password) {
  const userOk = timingSafeEqual(user || '', config.adminUser);
  const passwordOk = timingSafeEqual(password || '', config.adminPassword);
  return userOk && passwordOk;
}

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function createSessionToken() {
  const expiresAt = Date.now() + config.sessionHours * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ user: config.adminUser, expiresAt })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  if (!timingSafeEqual(signature, sign(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.expiresAt || Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

export function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionHours * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function requireAuth(req, res, next) {
  const session = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  if (!session) {
    // Dentro de um router montado, req.path e relativo ao mount point.
    // originalUrl traz o caminho completo, que e o que precisamos avaliar aqui.
    if ((req.originalUrl || '').startsWith('/admin/api/')) {
      return res.status(401).json({ error: 'Sessao expirada. Entre novamente.' });
    }
    return res.redirect('/admin/login');
  }
  req.session = session;
  return next();
}

export function redirectIfAuthenticated(req, res, next) {
  const session = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  if (session) return res.redirect('/admin');
  return next();
}
