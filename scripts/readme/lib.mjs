// Shared pieces for the README asset generators.
//
// GitHub serves README images through its camo proxy inside an <img>, which
// loads no external fonts, scripts or stylesheets. So every SVG here embeds
// the brand face (Space Mono, SIL OFL, Latin subset under ./fonts) as base64
// and pins monospace runs with textLength so alignment survives a fallback
// font. Node's standard library only: nothing here is installed or shipped.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT_DIR = join(ROOT, '.github', 'readme');

const b64 = (file) => readFileSync(join(HERE, 'fonts', file)).toString('base64');

export function fontFaces({ bold = true } = {}) {
  const face = (weight, file) =>
    `@font-face{font-family:'Space Mono';font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${b64(file)}) format('woff2')}`;
  return face(400, 'SpaceMono-400-latin.woff2') + (bold ? face(700, 'SpaceMono-700-latin.woff2') : '');
}

export const FONT = "'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const CHAR_W = 0.612; // Space Mono advance width, em

export const THEME = {
  text: '#e8e6f5', dim: '#8a85a8', muted: '#5a5670',
  accent: '#8b5cf6', bright: '#c084fc', magenta: '#c026d3',
  green: '#34d399', yellow: '#fbbf24', red: '#f87171', black: '#e8e6f5',
  termBg: '#0d0c14', termChrome: '#1a1826',
};

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function svgDoc({ w, h, title, desc, body, style = '', bold = false }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs><style>${fontFaces({ bold })}
text{font-family:${FONT};}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
${style}</style></defs>
${body}
</svg>
`;
}

/** Window frame: a wordmark tag, the title, an optional right label. No OS chrome. */
export function windowChrome({ w, h, chromeH, tag, title, right = '' }) {
  const t = THEME;
  const cy = chromeH / 2 + 4.5;
  const tagW = Math.round(tag.length * 12 * CHAR_W + 22);
  return `<linearGradient id="wc-accent" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.magenta}"/></linearGradient>
<rect width="${w}" height="${h}" rx="12" fill="${t.termBg}"/>
<rect width="${w}" height="${chromeH}" rx="12" fill="${t.termChrome}"/><rect y="${chromeH - 12}" width="${w}" height="12" fill="${t.termChrome}"/>
<rect y="${chromeH - 1}" width="${w}" height="1.5" fill="url(#wc-accent)" opacity="0.9"/>
<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="12" fill="none" stroke="url(#wc-accent)" stroke-width="1.5" opacity="0.55"/>
<rect x="12" y="${chromeH / 2 - 10}" width="${tagW}" height="20" rx="6" fill="${t.accent}" opacity="0.2"/>
<text x="${12 + tagW / 2}" y="${cy}" text-anchor="middle" font-size="12" fill="${t.bright}" letter-spacing="0.5">${esc(tag)}</text>
<text x="${w / 2}" y="${cy}" text-anchor="middle" font-size="12" fill="${t.dim}">${esc(title)}</text>
${right ? `<text x="${w - 16}" y="${cy}" text-anchor="end" font-size="11.5" fill="${t.muted}">${esc(right)}</text>` : ''}`;
}

/**
 * Render a transcript: rows are { kind: 'cmd', text } or { kind: 'out', segs: [{ text, tone }] }.
 * Commands type out, output appears, the whole thing loops (SMIL, no script).
 */
export function renderTerminal({ rows, tag, title, right, a11yTitle, a11yDesc, fontSize = 13.5 }) {
  const FS = fontSize, CW = +(FS * CHAR_W).toFixed(3), LH = 21, PAD = 22, CHROME = 38;
  const TYPE_S = 0.025, HOLD_S = 7;
  let t = 0.6;
  const timed = rows.map((r) => {
    const at = t;
    t += r.kind === 'cmd' ? r.text.length * TYPE_S + 0.45 : 0.3;
    return { ...r, t: at };
  });
  const END = t, LOOP = +(END + HOLD_S).toFixed(2);
  const width = (r) => (r.kind === 'cmd' ? r.text.length + 2 : r.segs.reduce((n, s) => n + s.text.length, 0));
  const COLS = Math.max(...rows.map(width));
  const W = Math.round(PAD * 2 + COLS * CW);
  const H = Math.round(CHROME + PAD + (rows.length + 1) * LH + PAD);
  const y = (i) => CHROME + PAD + i * LH + FS;
  const kt = (s) => Math.min(1, s / LOOP).toFixed(4);
  const appear = (s) => `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${kt(s)};${kt(s)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>`;
  const th = THEME;
  const els = [];
  timed.forEach((r, i) => {
    if (r.kind === 'cmd') {
      const n = r.text.length, w = +(n * CW).toFixed(2);
      const vals = [], keys = [];
      for (let k = 0; k <= n; k++) { vals.push((k * CW).toFixed(2)); keys.push(kt(r.t + k * TYPE_S)); }
      vals.push(w.toFixed(2)); keys.push('1');
      els.push(`<clipPath id="c${i}"><rect x="${PAD + 2 * CW}" y="${y(i) - FS}" height="${LH}" width="0"><animate attributeName="width" values="0;${vals.join(';')}" keyTimes="0;${keys.join(';')}" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/></rect></clipPath>`);
      els.push(`<text x="${PAD}" y="${y(i)}" font-size="${FS}" fill="${th.accent}" opacity="0">${appear(r.t)}$</text>`);
      els.push(`<text x="${PAD + 2 * CW}" y="${y(i)}" font-size="${FS}" fill="${th.text}" xml:space="preserve" textLength="${w}" lengthAdjust="spacingAndGlyphs" clip-path="url(#c${i})">${esc(r.text)}</text>`);
    } else {
      let col = 0;
      const parts = r.segs.map((s) => {
        const x = +(PAD + col * CW).toFixed(2);
        const trimmed = s.text.trimEnd();
        col += s.text.length;
        if (!trimmed) return '';
        return `<text x="${x}" y="${y(i)}" font-size="${FS}" fill="${th[s.tone] ?? th.dim}" xml:space="preserve" textLength="${+(trimmed.length * CW).toFixed(2)}" lengthAdjust="spacingAndGlyphs">${esc(trimmed)}</text>`;
      });
      els.push(`<g opacity="0">${appear(r.t)}${parts.join('')}</g>`);
    }
  });
  els.push(`<g opacity="0">${appear(END)}<text x="${PAD}" y="${y(rows.length)}" font-size="${FS}" fill="${th.accent}">$</text><rect class="blink" x="${PAD + 2 * CW}" y="${y(rows.length) - FS + 1}" width="${CW.toFixed(2)}" height="${LH - 3}" fill="${th.bright}"/></g>`);
  return svgDoc({
    w: W, h: H, title: a11yTitle, desc: a11yDesc,
    style: '.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}',
    body: windowChrome({ w: W, h: H, chromeH: CHROME, tag, title, right }) + '\n' + els.join('\n'),
  });
}
