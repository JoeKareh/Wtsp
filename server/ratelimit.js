// In-memory sliding-window limiter (one process). Keys should include the action, e.g. `signup:${ip}`.
const hits = new Map();
export function allow(key, max, windowMs) {
  const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a);
  if (hits.size > 50000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(k);
  return true;
}
export const resetLimits = () => hits.clear();
