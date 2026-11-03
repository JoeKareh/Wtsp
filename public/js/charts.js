// Dependency-free SVG charts. Colours come from the CSS categorical tokens (--s1..--s8) in fixed order.
import { esc, html, raw, num } from './core.js';
export const color = (i) => `var(--s${(i % 8) + 1})`;

function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
const short = (v) => { const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(v * 10) / 10); };
const legend = (series) => (series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><i style="background:${s.color || color(i)};${s.dashed ? 'opacity:.6' : ''}"></i>${esc(s.name)}</span>`).join('')}</div>` : '');
function tableView(labels, series, fmt) {
  return `<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">View as table</summary><div class="table-wrap" style="max-height:240px;overflow:auto"><table><thead><tr><th></th>${series.map((s) => `<th class="right">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td class="right mono">${s.data[i] == null ? '–' : esc(fmt(s.data[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
function attachTip(el, svgSel, compute) {
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; el.append(tip);
  const svg = el.querySelector('svg'); const hit = el.querySelector('[data-hit]'); if (!hit) return;
  const move = (e) => {
    const r = svg.getBoundingClientRect(); const pt = e.touches ? e.touches[0] : e;
    const x = ((pt.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
    const res = compute(x); if (!res) { tip.hidden = true; return; }
    tip.innerHTML = res.html; tip.hidden = false;
    const px = (res.x / svg.viewBox.baseVal.width) * r.width;
    tip.style.left = Math.min(Math.max(px + 12, 0), r.width - tip.offsetWidth) + 'px'; tip.style.top = '8px';
    el.querySelectorAll('[data-guide]').forEach((g) => { g.setAttribute('x1', res.x); g.setAttribute('x2', res.x); g.style.display = ''; });
    el.querySelectorAll('[data-dot]').forEach((d, i) => { const y = res.ys?.[i]; if (y == null) d.style.display = 'none'; else { d.style.display = ''; d.setAttribute('cx', res.x); d.setAttribute('cy', y); } });
  };
  const leave = () => { tip.hidden = true; el.querySelectorAll('[data-guide],[data-dot]').forEach((g) => (g.style.display = 'none')); };
  hit.addEventListener('mousemove', move); hit.addEventListener('mouseleave', leave); hit.addEventListener('touchstart', move, { passive: true }); hit.addEventListener('touchmove', move, { passive: true });
}

/** Line/area chart. series: [{name,data,color?,dashed?,area?}] */
export function drawLine(el, { labels, series, fmt = (v) => num(v, 2), height = 240, title }) {
  const W = 800, H = height, L = 52, R = 12, T = 10, B = 26; const iw = W - L - R, ih = H - T - B;
  const vals = series.flatMap((s) => s.data).filter((v) => v != null);
  const max = niceMax(Math.max(0, ...vals)); const min = Math.min(0, ...vals) < 0 ? -niceMax(-Math.min(...vals)) : 0;
  const n = labels.length; const x = (i) => L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); const y = (v) => T + ih - ((v - min) / (max - min || 1)) * ih;
  const ticks = [0, 1, 2, 3, 4].map((i) => min + ((max - min) * i) / 4);
  const every = Math.max(1, Math.ceil(n / 8));
  const paths = series.map((s, si) => {
    const c = s.color || color(si); let d = ''; let pen = false; const pts = [];
    s.data.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; pts.push([x(i), y(v)]); });
    const area = s.area && pts.length > 1 ? `<path d="${d}L${pts.at(-1)[0]},${y(Math.max(min, 0))}L${pts[0][0]},${y(Math.max(min, 0))}Z" fill="${c}" opacity=".12"/>` : '';
    const dots = n <= 31 ? s.data.map((v, i) => (v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="${s.dashed ? 0 : 3}" fill="${c}" stroke="var(--surface)" stroke-width="2"/>`)).join('') : '';
    return `${area}<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="5 4" opacity=".75"' : ''}/>${dots}`;
  }).join('');
  el.innerHTML = `<div class="chart">${legend(series)}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || 'Line chart')}">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${short(t / 100)}</text>`).join('')}
    ${labels.map((l, i) => (i % every === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(l.length > 7 ? l.slice(5) : l)}</text>` : '')).join('')}
    ${paths}<line data-guide y1="${T}" y2="${T + ih}" stroke="var(--border-strong)" style="display:none"/>
    ${series.map((s, i) => `<circle data-dot r="5" fill="${s.color || color(i)}" stroke="var(--surface)" stroke-width="2" style="display:none"/>`).join('')}
    <rect data-hit x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent"/></svg>${tableView(labels, series, fmt)}</div>`;
  const chart = el.firstElementChild;
  attachTip(chart, 'svg', (px) => {
    if (!n) return null; const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / iw) * (n - 1))));
    return { x: x(i), ys: series.map((s) => (s.data[i] == null ? null : y(s.data[i]))), html: `<b>${esc(labels[i])}</b>${series.map((s, si) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color || color(si)};margin-right:6px"></i>${series.length > 1 ? esc(s.name) + ': ' : ''}${s.data[i] == null ? '–' : esc(fmt(s.data[i]))}</div>`).join('')}` };
  });
}

/** Vertical bars (grouped when >1 series). */
export function drawBars(el, { labels, series, fmt = (v) => num(v, 2), height = 240, title }) {
  const W = 800, H = height, L = 52, R = 12, T = 10, B = 28; const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.data.filter((v) => v != null)))); const min = 0;
  const n = labels.length; const band = iw / Math.max(n, 1); const gap = 2; const bw = Math.max(2, Math.min(36, (band * 0.7 - gap * (series.length - 1)) / series.length));
  const y = (v) => T + ih - (v / (max || 1)) * ih; const every = Math.max(1, Math.ceil(n / 10));
  const bars = labels.map((l, i) => series.map((s, si) => { const v = s.data[i]; if (!v || v < 0) return ''; const bx = L + band * i + (band - (bw * series.length + gap * (series.length - 1))) / 2 + si * (bw + gap); const h = T + ih - y(v); const r = Math.min(4, bw / 2, h);
    return `<path d="M${bx},${T + ih}V${y(v) + r}Q${bx},${y(v)} ${bx + r},${y(v)}H${bx + bw - r}Q${bx + bw},${y(v)} ${bx + bw},${y(v) + r}V${T + ih}Z" fill="${s.color || color(si)}"/>`; }).join('')).join('');
  el.innerHTML = `<div class="chart">${legend(series)}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || 'Bar chart')}">
    ${[0, 1, 2, 3, 4].map((i) => { const t = (max * i) / 4; return `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${short(t / 100)}</text>`; }).join('')}
    ${labels.map((l, i) => (i % every === 0 ? `<text x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(l.length > 7 ? l.slice(5) : l)}</text>` : '')).join('')}
    ${bars}<line data-guide y1="${T}" y2="${T + ih}" stroke="var(--border-strong)" style="display:none"/><rect data-hit x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent"/></svg>${tableView(labels, series, fmt)}</div>`;
  attachTip(el.firstElementChild, 'svg', (px) => {
    const i = Math.floor((px - L) / band); if (i < 0 || i >= n) return null;
    return { x: L + band * i + band / 2, ys: [], html: `<b>${esc(labels[i])}</b>${series.map((s, si) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color || color(si)};margin-right:6px"></i>${series.length > 1 ? esc(s.name) + ': ' : ''}${s.data[i] == null ? '–' : esc(fmt(s.data[i]))}</div>`).join('')}` };
  });
}

/** Horizontal ranked bars (HTML). items: [{name,value,sub?,href?}] */
export function hbars(items, fmt = (v) => num(v, 2), { color: c = color(0), empty = 'No data in this period' } = {}) {
  if (!items.length) return html`<div class="empty">${empty}</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return html`<div class="bars">${items.map((i) => html`<div class="row" title="${i.name}: ${fmt(i.value)}"><span class="nm">${i.href ? html`<a href="${i.href}">${i.name}</a>` : i.name}${i.sub ? html` <span class="muted small">${i.sub}</span>` : ''}</span><div class="track"><div class="fill" style="width:${Math.max(2, (i.value / max) * 100)}%;background:${c}"></div></div><span class="mono">${fmt(i.value)}</span></div>`)}</div>`;
}

/** Donut with legend (max 7 slices + Other). */
export function drawDonut(el, { items, fmt = (v) => num(v, 2), title }) {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 7); const rest = sorted.slice(7).reduce((a, b) => a + b.value, 0); if (rest) top.push({ name: 'Other', value: rest });
  const total = top.reduce((a, b) => a + b.value, 0);
  if (!total) { el.innerHTML = '<div class="empty">No data in this period</div>'; return; }
  const R = 70, r = 44, C = 90; let a0 = -Math.PI / 2;
  const arcs = top.map((it, i) => { const frac = it.value / total; const a1 = a0 + frac * 2 * Math.PI - (top.length > 1 ? 0.02 : 0); const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${C + rad * Math.cos(a)},${C + rad * Math.sin(a)}`;
    const d = frac > 0.999 ? `M${C},${C - R}A${R},${R} 0 1 1 ${C - 0.01},${C - R}L${C - 0.01},${C - r}A${r},${r} 0 1 0 ${C},${C - r}Z` : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
    a0 += frac * 2 * Math.PI; return `<path d="${d}" fill="${color(i)}" data-i="${i}"><title>${esc(it.name)}: ${esc(fmt(it.value))} (${((frac) * 100).toFixed(1)}%)</title></path>`; }).join('');
  el.innerHTML = `<div class="chart" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 180 180" style="width:170px;flex:none" role="img" aria-label="${esc(title || 'Breakdown')}">${arcs}<text x="${C}" y="${C + 4}" text-anchor="middle" style="fill:var(--text);font-size:12px;font-weight:600">${esc(short(total / 100))}</text></svg>
    <div class="legend" style="flex-direction:column;flex:1;min-width:150px">${top.map((it, i) => `<span style="justify-content:space-between;width:100%"><span><i style="background:${color(i)}"></i>${esc(it.name)}</span><span class="mono">${esc(fmt(it.value))} · ${((it.value / total) * 100).toFixed(0)}%</span></span>`).join('')}</div></div>`;
}
