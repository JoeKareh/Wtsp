const stamp = () => new Date().toISOString();
const json = () => process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';
const out = (level, args) => {
  if (!json()) return (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(stamp(), level.toUpperCase(), ...args);
  const obj = args.find((a) => a && typeof a === 'object' && !(a instanceof Error)); const msg = args.filter((a) => !(a && typeof a === 'object') || a instanceof Error).map((a) => (a instanceof Error ? a.stack : String(a))).join(' ');
  (level === 'error' ? console.error : console.log)(JSON.stringify({ t: stamp(), level, msg, ...(obj || {}) }));
};
export const log = { info: (...a) => out('info', a), warn: (...a) => out('warn', a), error: (...a) => out('error', a) };
