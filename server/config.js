import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Minimal .env loader (no dependency). Real environment variables win.
try {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
} catch { /* ignore */ }

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  siteDir: path.join(root, 'public-site'),
  adminDir: path.join(root, 'public-admin'),
  get port() { return Number(env('PORT', 3000)); },
  get host() { return env('HOST', '0.0.0.0'); },
  get dbPath() { return abs(env('DB_PATH', 'data/bizcontrol.sqlite')); },
  get dataDir() { return path.dirname(this.dbPath); },
  get uploadsDir() { return path.join(this.dataDir, 'uploads'); },
  // ---- SaaS (multi-tenant) ----
  get appDomain() { return env('APP_DOMAIN').toLowerCase().replace(/:\d+$/, ''); },
  get saas() { return Boolean(this.appDomain); },
  get publicScheme() { return env('PUBLIC_SCHEME', this.cookieSecure ? 'https' : 'http'); },
  get publicPort() { return env('PUBLIC_PORT', ''); },
  get controlDbPath() { return abs(env('CONTROL_DB_PATH', path.join(path.dirname(abs(env('DB_PATH', 'data/bizcontrol.sqlite'))), 'control.sqlite'))); },
  get tenantsDir() { return abs(env('TENANTS_DIR', path.join(path.dirname(this.controlDbPath), 'tenants'))); },
  get poolMax() { return Number(env('TENANT_POOL_MAX', 200)); },
  tenantUrl(sub, p = '/') { return `${this.publicScheme}://${sub}.${this.appDomain}${this.publicPort ? ':' + this.publicPort : ''}${p}`; },
  platformUrl(p = '/') { return `${this.publicScheme}://${this.appDomain}${this.publicPort ? ':' + this.publicPort : ''}${p}`; },
  get cookieSecure() { return env('COOKIE_SECURE') === 'true'; },
  get trustProxy() { return env('TRUST_PROXY') === 'true'; },
  get baseUrl() { return env('BASE_URL', `http://localhost:${this.port}`).replace(/\/$/, ''); },
  // read lazily so tests / settings changes are respected
  wa: () => ({
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    wabaId: env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    version: env('WHATSAPP_API_VERSION', 'v21.0'),
    apiBase: env('WHATSAPP_API_BASE', 'https://graph.facebook.com').replace(/\/$/, ''),
  }),
  smtp: () => ({
    host: env('SMTP_HOST'), port: Number(env('SMTP_PORT', 587)), user: env('SMTP_USER'),
    pass: env('SMTP_PASS'), from: env('SMTP_FROM') || env('SMTP_USER'), security: env('SMTP_SECURITY', 'starttls'),
  }),
  platformSmtp: () => ({
    host: env('PLATFORM_SMTP_HOST', env('SMTP_HOST')), port: Number(env('PLATFORM_SMTP_PORT', env('SMTP_PORT', 587))), user: env('PLATFORM_SMTP_USER', env('SMTP_USER')),
    pass: env('PLATFORM_SMTP_PASS', env('SMTP_PASS')), from: env('PLATFORM_SMTP_FROM', env('SMTP_FROM') || env('SMTP_USER')), security: env('PLATFORM_SMTP_SECURITY', env('SMTP_SECURITY', 'starttls')),
  }),
  ai: () => ({ key: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'), base: env('ANTHROPIC_API_BASE', 'https://api.anthropic.com') }),
};
