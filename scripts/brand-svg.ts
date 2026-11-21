/**
 * Generates the brand SVG masters in docs/assets/ (see docs/BRAND.md).
 *
 * The wordmark is Urbanist Black (OFL) shaped by HarfBuzz (`hb-view`) and
 * written as glyph outlines, so the SVGs need no font. Rasters are built from
 * these masters by `scripts/brand-assets.sh`.
 *
 *   sh scripts/brand-assets.sh   (downloads Urbanist, runs this, rasterizes)
 *   URBANIST=/path/to/Urbanist[wght].ttf bun scripts/brand-svg.ts
 *
 * @module
 */

const OUT = new URL('../docs/assets/', import.meta.url).pathname;
const FONT = process.env.URBANIST;
if (!FONT) throw new Error('Set URBANIST to the path of Urbanist[wght].ttf (google/fonts, OFL)');

// ── palette (docs/BRAND.md) ─────────────────────────────────────────────────
const INK = '#0F1215';
const PAPER = '#FAFAFA';
const ORBIT = '#4E5459';
const BRACKET = '#5B6167';
const LIME_HI = '#D9F99D';
const LIME = '#A3E635';
const LIME_DEEP = '#65A30D';
const LIME_TEXT_LIGHT = '#4D7C0F'; // lime-700: AA on white
const ROUTE_DARK = '#7A828A'; // the other route, on dark surfaces
const ROUTE_LIGHT = '#9AA1A8'; // the other route, on light surfaces
const SLATE = '#8B939C';

const LABEL = '@xtandard/xyte';

// ── text → outlined paths via HarfBuzz ──────────────────────────────────────
interface Outline {
  /** `<path>` elements positioned on a baseline at y = 0. */
  body: string;
  width: number;
}

function outline(text: string, size: number, weight = 900): Outline {
  const r = Bun.spawnSync([
    'hb-view',
    `--font-file=${FONT}`,
    `--variations=wght=${weight}`,
    '--output-format=svg',
    '--margin=0',
    `--font-size=${size}`,
    text,
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const svg = r.stdout.toString();
  const glyphs = new Map<string, string>();
  for (const m of svg.matchAll(/<g id="(glyph-[\d-]+)">\s*<path d="([^"]*)"\s*\/>/g)) {
    glyphs.set(m[1]!, m[2]!.replace(/\s+/g, ' ').trim());
  }
  const baseline = Number(/<use[^>]*y="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  let body = '';
  for (const m of svg.matchAll(/<use xlink:href="#(glyph-[\d-]+)" x="([\d.]+)" y="([\d.]+)"\/>/g)) {
    const d = glyphs.get(m[1]!);
    if (!d) continue;
    const x = Number(m[2]);
    const y = Number(m[3]) - baseline;
    body += `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)})" d="${d}"/>`;
  }
  const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  return { body, width };
}

// ── the symbol (1024 grid) ──────────────────────────────────────────────────
// A lime X — a `>` chevron plus two arms — between grey angle brackets, as in
// every xtandard mark. xyte's glyph is a route: the upper arm ends in an
// arrowhead (the request going out), and a grey branch leaves the arm for a
// second node (another provider to fall back to).
const K = 165 / 212; // slope of the X's diagonals (dx per dy)
const L1 = (y: number) => 415 + (512 - y) * K;
const L2 = (y: number) => 560 + (512 - y) * K;
const GAP = 46;
const E = (y: number) => 395 + (y - 300) * K + GAP;

function intersect(line: (y: number) => number): [number, number] {
  // solve line(y) = E(y)
  let lo = 250;
  let hi = 512;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (line(mid) - E(mid) > 0) lo = mid;
    else hi = mid;
  }
  const y = (lo + hi) / 2;
  return [line(y), y];
}

const f = (n: number) => n.toFixed(1);
const [a1x, a1y] = intersect(L1);
const [a2x, a2y] = intersect(L2);
const chevron = 'M250 300L395 300L560 512L395 724L250 724L415 512Z';
// Lower arm: full length, mirroring the chevron's upper arm.
const lowerArm = `M${f(L1(300))} 724L${f(L2(300))} 724L${f(a2x)} ${f(1024 - a2y)}L${f(a1x)} ${f(1024 - a1y)}Z`;

// Upper arm: it runs up to the arrow's base and the arrowhead continues it
// along the same diagonal.
const CENTER = (y: number) => (L1(y) + L2(y)) / 2;
const NORM = Math.hypot(1, K);
const U = [K / NORM, -1 / NORM] as const; // along the arm, up and right
const N = [1 / NORM, K / NORM] as const; // across the arm, down and right
const HALF = 72.5 / NORM; // the arm's half width, across it
const at = (bx: number, by: number, u: number, n: number) => [bx + U[0] * u + N[0] * n, by + U[1] * u + N[1] * n] as const;
const pt = ([x, y]: readonly [number, number]) => `${f(x)} ${f(y)}`;

const BY = 318; // the arrow's base, on the arm's centre line
const BX = CENTER(BY);
const TIP = 150;
const WING = 118;
const NOTCH = 28;
const upperArm = `M${pt(at(BX, BY, NOTCH, -HALF))}L${pt(at(BX, BY, NOTCH, HALF))}L${f(a2x)} ${f(a2y)}L${f(a1x)} ${f(a1y)}Z`;
const arrow = `M${pt(at(BX, BY, 0, -WING))}L${pt(at(BX, BY, TIP, 0))}L${pt(at(BX, BY, 0, WING))}L${pt(at(BX, BY, NOTCH, 0))}Z`;

// The other route: from the arm's centre line, across it (down and right) to a node.
const RY = 410;
const RX = CENTER(RY);
const NODE = at(RX, RY, 0, 175);
const route = `M${f(RX)} ${RY}L${pt(NODE)}`;

const limeGradient = (id: string, light = false) =>
  `<linearGradient id="${id}" x1="250" y1="200" x2="760" y2="740" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${light ? '#A3E635' : LIME_HI}"/><stop offset=".42" stop-color="${light ? '#84CC16' : LIME}"/><stop offset="1" stop-color="${light ? LIME_TEXT_LIGHT : LIME_DEEP}"/></linearGradient>`;

function symbolBody(opts: { brackets?: boolean; mono?: string; route?: string } = {}): string {
  const fill = opts.mono ?? 'url(#lime)';
  const routeColor = opts.mono ?? opts.route ?? ROUTE_DARK;
  const routeOpacity = opts.mono ? ' opacity=".55"' : '';
  const brackets =
    opts.brackets === false
      ? ''
      : `<g fill="none" stroke="${opts.mono ?? BRACKET}" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"${opts.mono ? ' opacity=".6"' : ''}><path d="M190 438L118 512L190 586"/><path d="M834 438L906 512L834 586"/></g>`;
  // The route is drawn first so the arm covers its start.
  return `${brackets}
<g${routeOpacity}><path d="${route}" stroke="${routeColor}" stroke-width="30" stroke-linecap="round" fill="none"/>
<circle cx="${f(NODE[0])}" cy="${f(NODE[1])}" r="38" fill="${routeColor}"/></g>
<path d="${chevron}" fill="${fill}"/>
<path d="${upperArm}" fill="${fill}"/>
<path d="${arrow}" fill="${fill}"/>
<path d="${lowerArm}" fill="${fill}"/>`;
}

// Visible bounds of the symbol (with brackets) in the 1024 grid.
const TOP = Math.floor(at(BX, BY, TIP, 0)[1] - 16);
const RIGHT = Math.ceil(Math.max(at(BX, BY, 0, WING)[0], at(BX, BY, TIP, 0)[0], NODE[0] + 38) + 4);
const SYM = { x: 96, y: TOP, w: 832, h: 726 - TOP };
/** Bounds without the brackets (lockups). */
const MARK = { x: 244, y: TOP, w: RIGHT - 244, h: 726 - TOP };

const header = (w: number, h: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(w)} ${f(h)}" width="${f(w)}" height="${f(h)}" role="img" aria-label="${label}">\n<title>${label}</title>\n`;

const iconDefs = `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1A1C1F"/><stop offset="1" stop-color="#08090B"/></linearGradient><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#fff" stop-opacity=".03"/></linearGradient><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#000" flood-opacity=".55"/></filter>`;

const orbit = `<g fill="none" stroke="${ORBIT}" stroke-linecap="round">
<circle cx="512" cy="512" r="350" stroke-width="3" opacity=".22"/>
<path d="M614.1 102.5A422 422 0 0 1 933.4 489.9" stroke-width="4.5" opacity=".7"/>
<path d="M93.1 563.4A422 422 0 0 0 307.4 881.1" stroke-width="4.5" opacity=".7"/>
</g>
<g fill="${ORBIT}"><circle cx="614.1" cy="102.5" r="13"/><circle cx="933.4" cy="489.9" r="13"/><circle cx="93.1" cy="563.4" r="13"/><circle cx="307.4" cy="881.1" r="13"/></g>`;

function icon(opts: { orbit: boolean; shadow: boolean }): string {
  // Scale the symbol and centre it on the tile.
  const s = 0.86;
  const tx = 512 - (SYM.x + SYM.w / 2) * s;
  const ty = 512 - (SYM.y + SYM.h / 2) * s;
  return `<rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
<rect x="2" y="2" width="1020" height="1020" rx="222" fill="none" stroke="url(#rim)" stroke-width="4"/>
${opts.orbit ? orbit : ''}
<g transform="translate(${f(tx)} ${f(ty)}) scale(${s})"${opts.shadow ? ' filter="url(#shadow)"' : ''}>
${symbolBody()}
</g>`;
}

async function write(name: string, svg: string) {
  await Bun.write(`${OUT}${name}`, svg.endsWith('\n') ? svg : `${svg}\n`);
  console.log(`wrote docs/assets/${name}`);
}

// logo.svg — app icon
await write(
  'logo.svg',
  `${header(1024, 1024, LABEL)}<defs>${iconDefs}${limeGradient('lime')}</defs>\n${icon({ orbit: true, shadow: true })}\n</svg>`,
);

// favicon.svg — no orbit, no shadow (they don't survive 16 px)
await write(
  'favicon.svg',
  `${header(1024, 1024, LABEL)}<defs>${iconDefs}${limeGradient('lime')}</defs>\n${icon({ orbit: false, shadow: false })}\n</svg>`,
);

// symbol.svg — transparent symbol, cropped to its bounds
await write(
  'symbol.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SYM.x} ${f(SYM.y)} ${SYM.w} ${f(SYM.h)}" width="${SYM.w}" height="${f(SYM.h)}" role="img" aria-label="${LABEL}">\n<title>${LABEL}</title>\n<defs>${limeGradient('lime')}</defs>\n${symbolBody({ route: ROUTE_LIGHT })}\n</svg>`,
);

// ── lockups ─────────────────────────────────────────────────────────────────
// The npm name: `@xtandard/` in paper or ink, `xyte` in lime.
const PREFIX = outline('@xtandard/', 100);
const NAME = outline('xyte', 100);
// Urbanist's descenders (the @ and the y) go below the baseline, which sits on the X's base.
const DESC = 26;
const wordGradient = (light: boolean) =>
  `<linearGradient id="word" x1="0" y1="-60" x2="0" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${light ? '#84CC16' : LIME_HI}"/><stop offset="1" stop-color="${light ? LIME_TEXT_LIGHT : LIME}"/></linearGradient>`;

function horizontal(mode: 'dark' | 'light' | 'white' | 'black'): string {
  const mono = mode === 'white' ? '#FFFFFF' : mode === 'black' ? '#000000' : undefined;
  const symH = 150; // mark height in lockup units (the X's base sits on the text baseline)
  const s = symH / MARK.h;
  const symW = MARK.w * s;
  const gap = 26;
  const baseline = 4 + (724 - MARK.y) * s;
  const prefixFill = mono ?? (mode === 'dark' ? PAPER : INK);
  const nameFill = mono ?? 'url(#word)';
  const w = symW + gap + PREFIX.width + NAME.width + 4;
  const h = symH + 8 + DESC;
  const route = mode === 'light' ? ROUTE_LIGHT : ROUTE_DARK;
  const label = mono ? `${LABEL} (${mode})` : LABEL;
  return `${header(w, h, label)}<defs>${limeGradient('lime', mode === 'light')}${wordGradient(mode === 'light')}</defs>
<g transform="translate(0 4) scale(${s.toFixed(5)}) translate(${-MARK.x} ${f(-MARK.y)})">${symbolBody({ brackets: false, route, ...(mono ? { mono } : {}) })}</g>
<g transform="translate(${f(symW + gap)} ${f(baseline)})" fill="${prefixFill}">${PREFIX.body}</g>
<g transform="translate(${f(symW + gap + PREFIX.width)} ${f(baseline)})" fill="${nameFill}">${NAME.body}</g>
</svg>`;
}

function stacked(mode: 'dark' | 'light'): string {
  const symH = 232;
  const s = symH / MARK.h;
  const symW = MARK.w * s;
  const gap = 30;
  const textW = Math.max(PREFIX.width, NAME.width);
  const w = symW + gap + textW + 4;
  const h = symH + 8 + DESC;
  const route = mode === 'light' ? ROUTE_LIGHT : ROUTE_DARK;
  const base2 = 4 + (724 - MARK.y) * s;
  return `${header(w, h, LABEL)}<defs>${limeGradient('lime', mode === 'light')}${wordGradient(mode === 'light')}</defs>
<g transform="translate(0 4) scale(${s.toFixed(5)}) translate(${-MARK.x} ${f(-MARK.y)})">${symbolBody({ brackets: false, route })}</g>
<g transform="translate(${f(symW + gap)} ${f(base2 - 104)})" fill="${mode === 'dark' ? PAPER : INK}">${PREFIX.body}</g>
<g transform="translate(${f(symW + gap)} ${f(base2)})" fill="url(#word)">${NAME.body}</g>
</svg>`;
}

await write('lockup-horizontal-dark.svg', horizontal('dark'));
await write('lockup-horizontal-light.svg', horizontal('light'));
await write('lockup-stacked-dark.svg', stacked('dark'));
await write('lockup-stacked-light.svg', stacked('light'));
await write('monochrome-white.svg', horizontal('white'));
await write('monochrome-black.svg', horizontal('black'));

// ── social card 1280×640 ────────────────────────────────────────────────────
const TAG = outline('The Zyte API, on any proxy', 34, 600);
// JetBrains Mono is set as live text with fallbacks; the card is rasterized, so it is baked in social.png.
const CMD = `<text x="0" y="0" font-family="JetBrains Mono, ui-monospace, monospace" font-size="30" fill="${SLATE}">bun add @xtandard/xyte</text>`;
{
  const iconSize = 280;
  const titleScale = 0.9;
  const textX = 110 + iconSize + 56;
  const title = `<g transform="translate(${textX} 300) scale(${titleScale})"><g fill="${PAPER}">${PREFIX.body}</g><g transform="translate(${f(PREFIX.width)} 0)" fill="url(#word)">${NAME.body}</g></g>`;
  const fits = textX + (PREFIX.width + NAME.width) * titleScale;
  if (fits > 1240) console.warn(`social title overflows: ${fits}`);
  await write(
    'social.svg',
    `${header(1280, 640, LABEL)}<defs>${iconDefs}${limeGradient('lime')}${wordGradient(false)}</defs>
<rect width="1280" height="640" fill="${INK}"/>
<g transform="translate(110 180) scale(${(iconSize / 1024).toFixed(5)})">${icon({ orbit: true, shadow: true })}</g>
${title}
<g transform="translate(${textX} 362)" fill="${LIME_HI}">${TAG.body}</g>
<g transform="translate(${textX} 425)">${CMD}</g>
</svg>`,
  );
}
