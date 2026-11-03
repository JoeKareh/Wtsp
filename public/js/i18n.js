// Language support. English text is the key; locales/<code>.json maps it to another language. Missing strings simply stay English,
// so a new language (fr, es…) = add locales/<code>.json and its code to LANGS. Direction (RTL) comes from RTL.
export const LANGS = { en: 'English', ar: 'العربية' };
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
let dict = {}; export let lang = 'en';
export const t = (s, vars) => { let r = dict[s] ?? s; if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)); return r; };
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
function walk(node) {
  if (node.nodeType === 3) { const v = node.nodeValue; const k = v.trim(); if (k && dict[k] && dict[k] !== k) node.nodeValue = v.replace(k, dict[k]); return; }
  if (node.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA|CODE)$/.test(node.tagName) || node.closest?.('[data-notr]')) return;
  for (const a of ATTRS) { const v = node.getAttribute(a); if (v && dict[v]) node.setAttribute(a, dict[v]); }
  if (node.tagName === 'OPTION' && dict[node.textContent.trim()]) node.textContent = dict[node.textContent.trim()];
  for (const c of node.childNodes) walk(c);
}
export async function initLanguage(code) {
  lang = LANGS[code] ? code : 'en'; document.documentElement.lang = lang; document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  if (lang === 'en') return;
  try { const r = await fetch(`/locales/${lang}.json`); if (r.ok) dict = await r.json(); } catch { /* stay English */ }
  walk(document.body);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) walk(n); }).observe(document.body, { childList: true, subtree: true });
}
export const savedLang = () => { try { return localStorage.getItem('lang'); } catch { return null; } };
export const rememberLang = (l) => { try { localStorage.setItem('lang', l); } catch { /* ignore */ } };
