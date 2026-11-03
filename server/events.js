// Tiny synchronous event bus used to decouple modules (e.g. orders -> campaign attribution).
const handlers = {};
export const on = (name, fn) => { (handlers[name] ||= []).push(fn); };
export const emit = (name, payload) => { for (const fn of handlers[name] || []) { try { fn(payload); } catch (e) { console.error('event handler failed', name, e); } } };
