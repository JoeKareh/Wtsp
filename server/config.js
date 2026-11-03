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
  get port() { return Number(env('PORT', 3000)); },
  get host() { return env('HOST', '0.0.0.0'); },
  get dbPath() { return abs(env('DB_PATH', 'data/bizcontrol.sqlite')); },
  get dataDir() { return path.dirname(this.dbPath); },
  get uploadsDir() { return path.join(this.dataDir, 'uploads'); },
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
  ai: () => ({ key: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'), base: env('ANTHROPIC_API_BASE', 'https://api.anthropic.com') }),
};
