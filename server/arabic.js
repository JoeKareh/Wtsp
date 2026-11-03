// Arabic shaping (contextual joining forms + lam-alef ligatures) and a simplified bidirectional reordering, for PDF output.
// Browsers do this for us on screen; a PDF needs it done explicitly. Diacritics (tashkeel) are dropped: without OpenType positioning they would be misplaced.
import { FORMS, LAM_ALEF } from './arabic-forms.js';

const isArabicLetter = (cp) => (cp >= 0x0621 && cp <= 0x064a) || FORMS.has(cp);
const isMark = (cp) => (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || cp === 0x0640 && false;
export const isRtlChar = (cp) => (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
const isLatinLetter = (cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f);
const isDigit = (cp) => (cp >= 0x30 && cp <= 0x39) || (cp >= 0x660 && cp <= 0x669) || (cp >= 0x6f0 && cp <= 0x6f9);
const joinsNext = (cp) => { const f = FORMS.get(cp); return !!(f && f[2]); };          // dual-joining: connects to the following letter
const joinsPrev = (cp) => { const f = FORMS.get(cp); return !!(f && f[1]); };          // has a final form: connects to the preceding letter

/** Logical Arabic text -> logical code points using presentation forms. */
export function shape(str) {
  const cps = [...String(str)].map((c) => c.codePointAt(0)).filter((cp) => !isMark(cp));
  const out = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (!FORMS.has(cp)) { out.push(cp); continue; }
    const prev = i > 0 ? cps[i - 1] : 0; const next = cps[i + 1] ?? 0;
    const prevJoin = joinsNext(prev) && !(prev === 0x0644 && LAM_ALEF.has(cp) && false);
    if (cp === 0x0644 && LAM_ALEF.has(next)) { const lig = LAM_ALEF.get(next); out.push(prevJoin ? lig[1] : lig[0]); i++; continue; }   // لا
    const f = FORMS.get(cp); const nextJoin = joinsPrev(next) && joinsNext(cp);
    let form;
    if (f[2]) form = prevJoin && nextJoin ? f[3] : prevJoin ? f[1] : nextJoin ? f[2] : f[0];   // dual-joining
    else form = prevJoin && f[1] ? f[1] : f[0];                                                  // right-joining / non-joining
    out.push(form || f[0] || cp);
  }
  return out;
}
const MIRROR = new Map([[0x28, 0x29], [0x29, 0x28], [0x5b, 0x5d], [0x5d, 0x5b], [0x7b, 0x7d], [0x7d, 0x7b], [0x3c, 0x3e], [0x3e, 0x3c], [0xab, 0xbb], [0xbb, 0xab]]);
export const baseDirection = (str) => { for (const c of String(str)) { const cp = c.codePointAt(0); if (isRtlChar(cp) || isArabicLetter(cp)) return 'rtl'; if (isLatinLetter(cp)) return 'ltr'; } return 'ltr'; };

/**
 * Text -> code points in VISUAL left-to-right order (shaped). Simplified Unicode bidi: runs of RTL letters, runs of LTR letters/digits,
 * neutrals (space, punctuation) adopt the surrounding direction, otherwise the paragraph direction.
 */
export function visual(str, dir = 'auto') {
  const base = dir === 'auto' ? baseDirection(str) : dir;
  const chars = [...String(str)].map((c) => c.codePointAt(0)).filter((cp) => !isMark(cp));
  // classify
  const cls = chars.map((cp) => (isRtlChar(cp) || FORMS.has(cp) ? 'R' : isLatinLetter(cp) || isDigit(cp) ? 'L' : 'N'));
  // resolve neutrals: between two strong chars of the same direction -> that direction, else paragraph direction
  const dirs = cls.map((c) => (c === 'R' ? 'rtl' : c === 'L' ? 'ltr' : null));
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i]) continue; let j = i; while (j < dirs.length && !dirs[j]) j++;
    const before = i > 0 ? dirs[i - 1] : null; const after = j < dirs.length ? dirs[j] : null; const d = before && before === after ? before : base;
    for (let k = i; k < j; k++) dirs[k] = d; i = j - 1;
  }
  // split into runs of equal direction
  const runs = []; for (let i = 0; i < chars.length; i++) { const last = runs[runs.length - 1]; if (last && last.dir === dirs[i]) last.cps.push(chars[i]); else runs.push({ dir: dirs[i], cps: [chars[i]] }); }
  const shapedRun = (r) => (r.dir === 'rtl' ? shape(String.fromCodePoint(...r.cps)).reverse().map((cp) => (base === 'rtl' || true ? MIRROR.get(cp) ?? cp : cp)) : r.cps);
  const ordered = base === 'rtl' ? [...runs].reverse() : runs;
  return ordered.flatMap((r) => shapedRun(r));
}
export const hasArabic = (s) => /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(String(s));
