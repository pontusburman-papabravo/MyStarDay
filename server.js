const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { globalLimiter } = require('./src/middleware/rateLimiter');
const { loadLocales, getLocale, getAvailableLanguages } = require('./src/lib/i18n');
const { startMidnightScheduler } = require('./src/lib/midnight-scheduler');
const { startDeletionScheduler } = require('./src/lib/deletion-scheduler');
const config = require('./src/lib/config');
const db = require('./src/lib/db');

const app = express();
const port = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────
app.set('trust proxy', 1); // Trust Render's proxy for rate limiting
app.use(express.json());
app.use(cookieParser());
app.use(globalLimiter);

// ─── Load i18n ────────────────────────────────────────────
loadLocales();

// ─── Health check (no DB query — allows Neon auto-suspend) ─
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '2.2.0' });
});

// ─── Redirect secondary domains to main domain ────────────
// mystarday.eu, minstjärndag.se, stjärndag.se → mystarday.se
const REDIRECT_DOMAINS = new Set([
  'mystarday.eu',
  'www.mystarday.eu',
  'minstjärndag.se',
  'www.minstjärndag.se',
  'stjärndag.se',
  'www.stjärndag.se',
  // Punycode variants (some DNS resolvers pass the encoded form)
  'xn--minstjrndag-q8a.se',
  'www.xn--minstjrndag-q8a.se',
  'xn--stjrndag-2za.se',
  'www.xn--stjrndag-2za.se',
]);
const MAIN_DOMAIN = 'mystarday.se';

// Apply redirect after static file serving so we don't catch /health etc
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host && REDIRECT_DOMAINS.has(host)) {
    return res.redirect(301, `https://${MAIN_DOMAIN}${req.originalUrl}`);
  }
  next();
});

// ─── i18n API ─────────────────────────────────────────────
app.get('/api/i18n/:lang', (req, res) => {
  const locale = getLocale(req.params.lang);
  res.json(locale);
});

app.get('/api/i18n', (req, res) => {
  res.json({ languages: getAvailableLanguages(), default: 'sv' });
});

// ─── API Routes ───────────────────────────────────────────
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/family', require('./src/routes/family'));
app.use('/api/children', require('./src/routes/children'));
app.use('/api/account', require('./src/routes/account'));
app.use('/api/categories', require('./src/routes/categories'));
app.use('/api/activity-templates', require('./src/routes/activity-templates'));

// Weekly schedule routes (child-scoped and schedule-scoped)
const { childRouter: schedulesChildRouter, scheduleRouter: scheduleItemsRouter } = require('./src/routes/schedules');
app.use('/api/children/:childId/schedules', schedulesChildRouter);
app.use('/api/schedules/:scheduleId/items', scheduleItemsRouter);

// Daily log routes
const { childRouter: dailyLogChildRouter, itemRouter: dailyLogItemRouter, logRouter: dailyLogRouter, childSelfRouter: dailyLogChildSelfRouter } = require('./src/routes/daily-logs');
app.use('/api/children', dailyLogChildRouter);
app.use('/api/daily-log-items', dailyLogItemRouter);
app.use('/api/daily-logs', dailyLogRouter);
// Child self-access: authenticated child can fetch their own log and mark items done
app.use('/api/me', dailyLogChildSelfRouter);

// Rewards + redemptions (parent routes)
const { parentRouter: rewardsParentRouter, childRouter: rewardsChildRouter } = require('./src/routes/rewards');
app.use('/api/rewards', rewardsParentRouter);
// Child self-access for rewards: GET /api/me/rewards, POST /api/me/rewards/:id/redeem
app.use('/api/me', rewardsChildRouter);

// Ratings routes
const { childRouter: ratingsChildRouter, parentRouter: ratingsParentRouter } = require('./src/routes/ratings');
// Child: POST /api/me/daily-log-items/:itemId/rate, GET /api/me/daily-log-items/:itemId/rating
app.use('/api/me', ratingsChildRouter);
// Parent: POST /api/daily-log-items/:itemId/rate, GET /api/daily-log-items/:itemId/ratings
app.use('/api/daily-log-items', ratingsParentRouter);

app.use('/api', require('./src/routes/public'));
app.use('/api/feedback', require('./src/routes/feedback'));

// ─── Static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Maintenance mode check ────────────────────────────────
// Blocks all non-admin traffic when maintenance_mode is enabled.
let maintenanceCache = null;
let maintenanceCacheAt = 0;
const MAINTENANCE_CACHE_TTL = 5000; // 5 seconds

async function checkMaintenanceMode(req, res, next) {
  // Always allow health check
  if (req.path === '/health') return next();

  // Always allow admin login flow during maintenance
  // (without this, admin can't reach the login page to authenticate)
  const allowedPaths = ['/login', '/admin', '/api/auth/login', '/api/auth/me'];
  if (allowedPaths.includes(req.path)) return next();

  // Allow static assets needed for login/admin pages
  if (req.path.startsWith('/js/') || req.path.startsWith('/css/')) return next();

  const now = Date.now();
  if (!maintenanceCache || (now - maintenanceCacheAt) > MAINTENANCE_CACHE_TTL) {
    try {
      const result = await db.query(
        "SELECT enabled FROM feature_flag WHERE key = 'maintenance_mode' LIMIT 1"
      );
      maintenanceCache = result.rows.length > 0 ? result.rows[0].enabled : false;
      maintenanceCacheAt = now;
    } catch {
      maintenanceCache = false;
    }
  }

  if (!maintenanceCache) return next();

  // Maintenance mode ON — check if user is admin
  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : (req.cookies?.token || null);

  let isAdmin = false;
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      isAdmin = decoded.type === 'parent' && decoded.isAdmin === true;
    } catch {
      // invalid token — treat as non-admin
    }
  }

  if (isAdmin) return next();

  // Non-admin: show maintenance page
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(503).send(`
    <!DOCTYPE html>
    <html lang="sv">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Underhåll — Min Stjärndag</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #E8F0FE; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: white; border-radius: 20px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 24px rgba(27,35,64,0.1); }
        .icon { font-size: 64px; margin-bottom: 24px; }
        h1 { font-family: 'Outfit', sans-serif; font-size: 28px; color: #1B2340; margin-bottom: 16px; }
        p { color: #5A6178; font-size: 16px; line-height: 1.6; margin-bottom: 32px; }
        .contact { font-size: 14px; color: #5A6178; }
        .contact a { color: #F5A623; text-decoration: none; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">&#9888;&#65039;</div>
        <h1>Vi genomför underhåll</h1>
        <p>Min Stjärndag är tillfälligt stängd för underhåll. Vi är snart tillbaka — tack för ditt tålamod!</p>
        <p class="contact">Frågor? Kontakta oss på <a href="mailto:info@mystarday.se">info@mystarday.se</a></p>
        <p style="margin-top: 48px;"><a href="/login" style="color: rgba(90,97,120,0.3); font-size: 12px; text-decoration: none;">Admin</a></p>
      </div>
    </body>
    </html>
  `);
}

app.use(checkMaintenanceMode);

// ─── Landing page with analytics beacon ───────────────────
// Injects app mode server-side so the child-login section works even if
// the /api route is not reachable from a custom domain proxy.
app.get('/', async (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);

    // Inject app mode so client JS can read it without an API call.
    // This fixes the child-login button on custom domains that don't route /api.
    try {
      const result = await db.query(
        "SELECT key, enabled FROM feature_flag WHERE key IN ('registration_enabled', 'maintenance_mode')"
      );
      const flags = {};
      for (const row of result.rows) flags[row.key] = row.enabled;

      let mode = 'beta';
      if (flags.maintenance_mode) mode = 'maintenance';
      else if (flags.registration_enabled) mode = 'registration';

      const injectedScript = `<script>window.__APP_MODE__ = ${JSON.stringify({ mode, registration_enabled: flags.registration_enabled || false })};</script>`;
      const beforeReplace = html.substring(html.length - 200);
      html = html.replace('</body>', injectedScript + '</body>');
      const afterReplace = html.substring(html.length - 200);
      console.log('[LANDING] Mode injection OK — mode=' + mode + ', beforeEnds=' + beforeReplace.includes('</body>') + ', afterEnds=' + afterReplace.includes('</body>') + ', hasScript=' + afterReplace.includes('__APP_MODE__'));
    } catch (err) {
      console.error('[LANDING] Mode injection error:', err.message || err);
    }

    res.type('html').send(html);
  } else {
    res.json({ message: 'Min Stjärndag API' });
  }
});

// ─── SPA fallback for app pages ───────────────────────────
const appPages = [
  'login', 'child-login',
  'verify-email', 'forgot-password', 'reset-password',
  'dashboard', 'child-dashboard',
  'settings', 'accept-invite',
  'activities', 'schedule', 'daily-log',
  'family',
];

for (const page of appPages) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
}

// Registration — only serves the register page when registration_enabled flag is on.
app.get('/register', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT enabled FROM feature_flag WHERE key = 'registration_enabled' LIMIT 1"
    );
    const registrationEnabled = result.rows.length > 0 ? result.rows[0].enabled : false;

    if (!registrationEnabled) {
      return res.redirect('/login?reason=registration_closed');
    }

    res.sendFile(path.join(__dirname, 'public', 'register.html'));
  } catch (err) {
    console.error('[SERVER] Registration check error:', err);
    res.redirect('/login');
  }
});

// Beta signup page
app.get('/beta', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'beta.html'));
});

// Admin page (hidden — no public navigation links)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Privacy policy page
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// ─── 404 handler ──────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint hittades inte' });
  }
  res.redirect('/');
});

// ─── Error handler ────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ error: 'Internt serverfel' });
});

// ─── Start ────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Min Stjärndag running on port ${port}`);
  startMidnightScheduler();
  startDeletionScheduler();
});
