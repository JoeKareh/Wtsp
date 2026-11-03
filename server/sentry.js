// Optional error reporting to Sentry (or a compatible server such as GlitchTip). Zero dependencies: posts an event envelope with fetch.
// Active only when SENTRY_DSN is set. UNVERIFIED against a live Sentry project: check the first event arrives after deploying.
let target = null;
export function initSentry() {
  const dsn = process.env.SENTRY_DSN; if (!dsn) return false;
  try { const u = new URL(dsn); target = { url: `${u.protocol}//${u.host}/api/${u.pathname.replace(/\//g, '')}/envelope/?sentry_key=${u.username}&sentry_version=7`, dsn }; return true; } catch { return false; }
}
export function reportError(err, extra = {}) {
  if (!target) return;
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ev = { event_id: id, timestamp: Date.now() / 1000, platform: 'node', level: 'error', environment: process.env.NODE_ENV || 'development', release: process.env.APP_VERSION || undefined, server_name: process.env.HOSTNAME || undefined,
    exception: { values: [{ type: err?.name || 'Error', value: String(err?.message || err).slice(0, 500), stacktrace: { frames: String(err?.stack || '').split('\n').slice(1, 12).map((l) => ({ filename: l.trim() })).reverse() } }] }, extra };
  const body = `${JSON.stringify({ event_id: id, dsn: target.dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(ev)}`;
  fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body, signal: AbortSignal.timeout(5000) }).catch(() => {});
}
