// Small SVG bar charts. No library and no inline styles (the app's Content-Security-Policy forbids them):
// sizes are SVG attributes and colours come from styles.css (.cbar, .cbar.red, .cbar.amber, .cbar.grey).
// `narrow` draws a smaller canvas so text stays readable on a phone instead of shrinking with a wide chart.
import { esc } from './core.js';

const short = n => (n >= 1e7 ? (n / 1e7).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + ' Cr'
  : n >= 1e5 ? (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L'
    : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(n)));
const full = (n, money) => (money ? '₹' : '') + Number(n).toLocaleString('en-IN');

/** A round step (1, 2, 2.5, 5 × 10^n) so that 4 steps cover `max`; whole numbers for counts. */
function axisStep(max, money) {
  const raw = Math.max(max, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  if (!money) step = Math.max(1, Math.ceil(step));
  return step;
}

/** Vertical bars in the order given. rows: [{ label, sub, value, tip, href }]. */
export function columnChart(rows, { money = true, title = 'Chart', narrow = false, half = false } = {}) {
  if (!rows.length) return '<p class="state small">Nothing to show for this period.</p>';
  const W = narrow ? 360 : half ? 520 : 920, H = narrow ? 230 : 280, L = narrow ? 44 : 56, R = 8, T = 22, B = 44;
  const step = axisStep(Math.max(...rows.map(r => r.value)), money); const max = step * 4;
  const iw = W - L - R, ih = H - T - B, slot = iw / rows.length, bw = Math.max(Math.min(slot * 0.7, 56), 2);
  const y = v => T + ih - (v / max) * ih; const pre = money ? '₹' : '';
  const maxLabels = narrow ? 8 : half ? 12 : 16; const every = Math.ceil(rows.length / maxLabels);
  const showValues = rows.filter(r => r.value > 0).length <= maxLabels;
  const grid = [0, 1, 2, 3, 4].map(i => { const v = step * i;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${pre}${short(v)}</text>`; }).join('');
  const bars = rows.map((r, i) => {
    const x = L + i * slot + (slot - bw) / 2; const h = Math.max(T + ih - y(r.value), r.value > 0 ? 1 : 0); const cx = (x + bw / 2).toFixed(1);
    const tip = r.tip || `${r.label} ${r.sub || ''}: ${full(r.value, money)}`;
    // An invisible full-height target makes short (or zero) bars easy to tap.
    const shape = `<rect class="hit" x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ih}"/>`
      + `<rect class="cbar ${r.cls || ''}" x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
    return (r.href ? `<a href="${esc(r.href)}" aria-label="${esc(tip)}"><title>${esc(tip)}</title>${shape}</a>` : `<g><title>${esc(tip)}</title>${shape}</g>`)
      + (showValues && r.value > 0 ? `<text class="val" x="${cx}" y="${(T + ih - h - 5).toFixed(1)}" text-anchor="middle">${pre}${short(r.value)}</text>` : '')
      + ((rows.length - 1 - i) % every === 0 ? `<text x="${cx}" y="${H - B + 16}" text-anchor="middle">${esc(r.label)}</text>${r.sub ? `<text x="${cx}" y="${H - B + 30}" text-anchor="middle">${esc(r.sub)}</text>` : ''}` : '');
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>`;
}

/** Horizontal bars, in the order given: for comparing people or groups. rows: [{ label, value, note, href, cls }]. */
export function barList(rows, { money = true, title = 'Chart', narrow = false } = {}) {
  if (!rows.length) return '<p class="state small">Nothing to show for this period.</p>';
  const W = narrow ? 340 : 460, RH = 30, LW = narrow ? 118 : 150, VW = narrow ? 96 : 150, maxChars = narrow ? 15 : 20;
  const max = Math.max(...rows.map(r => r.value), 1);
  const body = rows.map((r, i) => {
    const yy = i * RH; const w = Math.max((r.value / max) * (W - LW - VW), r.value > 0 ? 2 : 0);
    const label = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
    const tip = `${r.label}: ${full(r.value, money)}${r.note ? ' · ' + r.note : ''}`;
    const row = `<title>${esc(tip)}</title><rect class="hit" x="0" y="${yy + 2}" width="${W}" height="${RH - 4}"/>
      <text x="${LW - 8}" y="${yy + 19}" text-anchor="end">${esc(label)}</text>
      <rect class="cbar ${r.cls || ''}" x="${LW}" y="${yy + 7}" width="${w.toFixed(1)}" height="16" rx="2"/>
      <text class="val" x="${(LW + w + 6).toFixed(1)}" y="${yy + 19}">${full(r.value, money)}${r.note && !narrow ? ` <tspan class="note">${esc(r.note)}</tspan>` : ''}</text>`;
    return r.href ? `<a href="${esc(r.href)}" aria-label="${esc(tip)}">${row}</a>` : `<g>${row}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${rows.length * RH + 4}" role="img" aria-label="${esc(title)}">${body}</svg>`;
}
