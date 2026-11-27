import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { requireAuth, redirectIfAuthenticated } from './auth.js';
import leadRouter from './routes/lead.js';
import adminRouter from './routes/admin.js';
import oauthRouter from './routes/oauth.js';
import { purgeOldSubmissions } from './db.js';
import { startOAuthScheduler } from './shopifyOAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// Cabecalhos de seguranca basicos. O painel nao carrega recurso externo algum.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (!req.path.startsWith('/api/')) {
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    );
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, stores: config.stores.size, environment: config.nodeEnv });
});

app.use('/api', leadRouter);
app.use('/admin/api', adminRouter);
app.use('/oauth', oauthRouter);

app.get('/admin/login', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '1h' }));

app.get('/', (req, res) => res.redirect('/admin'));

app.use((req, res) => {
  res.status(404).json({ error: 'Rota nao encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error('[erro nao tratado]', error.message);
  res.status(500).json({ error: 'Erro interno.' });
});

const server = app.listen(config.port, () => {
  console.log(`\nShopify Lead Bridge no ar`);
  console.log(`  Painel:   http://localhost:${config.port}/admin`);
  console.log(`  Endpoint: POST http://localhost:${config.port}/api/lead`);
  console.log(`  Lojas:    ${[...config.stores.keys()].join(', ')}`);
  console.log(`  Ambiente: ${config.nodeEnv}\n`);

  const removed = purgeOldSubmissions();
  if (removed) console.log(`[retencao] ${removed} registros antigos removidos.`);

  startOAuthScheduler();
});

// Limpeza diaria do historico conforme RETENTION_DAYS.
setInterval(() => {
  const removed = purgeOldSubmissions();
  if (removed) console.log(`[retencao] ${removed} registros antigos removidos.`);
}, 24 * 60 * 60 * 1000).unref();

function shutdown(signal) {
  console.log(`\n${signal} recebido, encerrando.`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
