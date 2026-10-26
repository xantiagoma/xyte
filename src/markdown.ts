/**
 * HTML → Markdown, for Zyte's non-AI `markdown` output. Dependency-free: a tolerant tag parser
 * builds a small tree, then a renderer walks it. Good enough for LLM input and reading; it is not
 * a full HTML5 parser.
 */

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent?: Element;
}
type Node = Element | string;

/** Options of `htmlToMarkdown()`. */
export interface MarkdownOptions {
  /** Base for relative links and images. */
  url?: string;
  /** Zyte's `markdownOptions.scope`. Default `mainContent`. */
  scope?: 'mainContent' | 'fullPage';
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'canvas', 'iframe', 'object', 'button', 'select', 'input', 'textarea']);
/** Dropped inside the main content (its own `<header>` usually holds the title, so it stays). */
const CHROME = new Set(['nav', 'aside', 'form', 'dialog']);
const NO_CHROME = new Set<string>();
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Opening one of these closes an open element of the same group (`<p>a<p>b`, `<li>a<li>b`). */
const AUTO_CLOSE: Record<string, readonly string[]> = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
};

export function parseHtml(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  let current = root;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = tokens.exec(html))) {
    if (match.index > last) current.children.push(html.slice(last, match.index));
    last = tokens.lastIndex;
    const [, closing, opening, rawAttrs = '', selfClosing] = match;

    if (closing) {
      const tag = closing.toLowerCase();
      for (let el: Element | undefined = current; el && el !== root; el = el.parent) {
        if (el.tag === tag) {
          current = el.parent ?? root;
          break;
        }
      }
      continue;
    }
    if (!opening) continue; // comment, doctype, CDATA

    const tag = opening.toLowerCase();
    // HTML closes an open <p> when a block starts (<p>text<ul>… puts the list after the p).
    if (BLOCK.has(tag)) {
      for (let el: Element | undefined = current; el && el !== root; el = el.parent) {
        if (el.tag === 'p') {
          current = el.parent ?? root;
          break;
        }
        if (BLOCK.has(el.tag)) break;
      }
    }
    const closes = AUTO_CLOSE[tag];
    if (closes) {
      for (let el: Element | undefined = current; el && el !== root && !BLOCK_BOUNDARY.has(el.tag); el = el.parent) {
        if (closes.includes(el.tag)) {
          current = el.parent ?? root;
          break;
        }
      }
    }
    const element: Element = { tag, attrs: parseAttrs(rawAttrs), children: [], parent: current };
    current.children.push(element);

    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end === -1 ? html.length : end;
      element.children.push(html.slice(last, stop));
      const close = html.indexOf('>', stop);
      tokens.lastIndex = last = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !selfClosing) current = element;
  }
  if (last < html.length) current.children.push(html.slice(last));
  return root;
}

/** Auto-closing a `<li>` must not escape the list it is in. */
const BLOCK_BOUNDARY = new Set(['ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'dl', 'select']);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', laquo: '«', raquo: '»', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return NAMED[entity.toLowerCase()] ?? all;
  });
}

const NOISE_CLASS =
  /(?:^|[\s_-])(?:nav|navbar|menu|dropdown|sidebar|breadcrumbs?|toc|cookie|consent|banner|share|sharing|social|related|newsletter|subscribe|advert|ads?|promo|popup|modal|skip|sr-only|visually-hidden|mw-editsection|noprint)(?:$|[\s_-])/i;
const NOISE_ROLE = new Set(['navigation', 'menu', 'menubar', 'banner', 'contentinfo', 'complementary', 'dialog', 'search']);

/** Hidden or boilerplate elements, left out of `mainContent`. */
function isNoise(el: Element): boolean {
  const { attrs } = el;
  if ('hidden' in attrs || attrs['aria-hidden'] === 'true') return true;
  if (attrs.style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style)) return true;
  if (attrs.role && NOISE_ROLE.has(attrs.role)) return true;
  return NOISE_CLASS.test(`${attrs.class ?? ''} ${attrs.id ?? ''}`);
}

function find(node: Element, predicate: (el: Element) => boolean): Element[] {
  const found: Element[] = [];
  const walk = (el: Element) => {
    if (predicate(el)) found.push(el);
    for (const child of el.children) if (typeof child !== 'string') walk(child);
  };
  walk(node);
  return found;
}

function textLength(node: Node): number {
  if (typeof node === 'string') return node.trim().length;
  if (SKIP.has(node.tag)) return 0;
  return node.children.reduce((sum, child) => sum + textLength(child), 0);
}

/** `<main>`, `role=main`, or the longest `<article>`; undefined when none is found. */
function mainContent(root: Element): Element | undefined {
  const main = find(root, (el) => el.tag === 'main' || el.attrs.role === 'main');
  if (main.length > 0) return main.sort((a, b) => textLength(b) - textLength(a))[0];
  const articles = find(root, (el) => el.tag === 'article');
  if (articles.length > 0) return articles.sort((a, b) => textLength(b) - textLength(a))[0];
  return undefined;
}

/**
 * The built-in `markdown` extraction: HTML to Markdown, the main content only (Zyte's default) or the
 * whole page. Relative links and images are resolved against `url`.
 */
export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const root = parseHtml(html);
  const scope = options.scope ?? 'mainContent';
  const main = scope === 'mainContent' ? mainContent(root) : undefined;
  // Zyte: "When no main content can be identified, the full page is returned instead."
  const chrome = main ? CHROME : NO_CHROME;
  const base = options.url;

  const resolve = (href: string | undefined): string => {
    if (!href) return '';
    try {
      return base ? new URL(href, base).toString() : href;
    } catch {
      return href;
    }
  };

  const inline = (nodes: Node[], pre = false): string => nodes.map((node) => renderInline(node, pre)).join('');

  function renderInline(node: Node, pre: boolean): string {
    if (typeof node === 'string') {
      const text = decodeEntities(node);
      return pre ? text : text.replace(/\s+/g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
    }
    const { tag, attrs } = node;
    if (SKIP.has(tag) || chrome.has(tag) || (main && isNoise(node))) return '';
    if (BLOCK.has(tag)) return ` ${block([node]).trim()} `;
    switch (tag) {
      case 'br':
        return pre ? '\n' : '  \n';
      case 'strong':
      case 'b': {
        const inner = inline(node.children).trim();
        return inner ? `**${inner}**` : '';
      }
      case 'em':
      case 'i': {
        const inner = inline(node.children).trim();
        return inner ? `*${inner}*` : '';
      }
      case 's':
      case 'del':
      case 'strike': {
        const inner = inline(node.children).trim();
        return inner ? `~~${inner}~~` : '';
      }
      case 'code': {
        if (pre) return inline(node.children, true);
        const inner = decodeEntities(textOf(node));
        return inner ? `\`${inner.replace(/`/g, '\\`')}\`` : '';
      }
      case 'a': {
        const label = inline(node.children).trim();
        const href = attrs.href;
        if (!href || href.startsWith('javascript:')) return label;
        if (!label) return '';
        return `[${label}](${resolve(href)})`;
      }
      case 'img': {
        const src = attrs.src || attrs['data-src'];
        return src ? `![${(attrs.alt ?? '').replace(/[[\]]/g, '')}](${resolve(src)})` : '';
      }
      default:
        return inline(node.children, pre);
    }
  }

  function textOf(node: Node): string {
    return typeof node === 'string' ? node : node.children.map(textOf).join('');
  }

  /** Renders block-level content as paragraphs separated by blank lines. */
  function block(nodes: Node[], depth = 0): string {
    const out: string[] = [];
    let run: Node[] = [];
    const flush = () => {
      const text = inline(run).replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).replace(/ {2,}(?!\n)/g, ' ').trim();
      if (text) out.push(text);
      run = [];
    };

    for (const node of nodes) {
      if (typeof node === 'string' || !BLOCK.has(node.tag)) {
        run.push(node);
        continue;
      }
      flush();
      const { tag } = node;
      if (chrome.has(tag) || (main && isNoise(node))) continue;
      if (/^h[1-6]$/.test(tag)) {
        const text = inline(node.children).trim();
        if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      } else if (tag === 'hr') {
        out.push('---');
      } else if (tag === 'pre') {
        const code = decodeEntities(textOf(node)).replace(/^\n|\n$/g, '');
        const lang = /language-(\S+)/.exec(find(node, (el) => el.tag === 'code')[0]?.attrs.class ?? '')?.[1] ?? '';
        out.push(`\`\`\`${lang}\n${code}\n\`\`\``);
      } else if (tag === 'blockquote') {
        const inner = block(node.children, depth);
        if (inner) out.push(inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
      } else if (tag === 'ul' || tag === 'ol') {
        const list = renderList(node, depth);
        if (list) out.push(list);
      } else if (tag === 'table') {
        const table = renderTable(node);
        if (table) out.push(table);
      } else {
        const inner = block(node.children, depth);
        if (inner) out.push(inner);
      }
    }
    flush();
    return out.join('\n\n');
  }

  function renderList(list: Element, depth: number): string {
    const ordered = list.tag === 'ol';
    let n = Number(list.attrs.start ?? 1) || 1;
    const lines: string[] = [];
    for (const item of list.children) {
      if (typeof item === 'string' || item.tag !== 'li') continue;
      const nested = item.children.filter((c): c is Element => typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol'));
      const own = item.children.filter((c) => !nested.includes(c as Element));
      const text = block(own, depth + 1).replace(/\n\n+/g, '\n');
      const marker = ordered ? `${n++}.` : '-';
      const indent = ' '.repeat(marker.length + 1);
      const body = text.split('\n').map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
      lines.push(`${marker} ${body}`.trimEnd());
      for (const sub of nested) {
        const rendered = renderList(sub, depth + 1);
        if (rendered) lines.push(rendered.split('\n').map((line) => `${indent}${line}`).join('\n'));
      }
    }
    return lines.join('\n');
  }

  function renderTable(table: Element): string {
    const rows = find(table, (el) => el.tag === 'tr').map((tr) =>
      tr.children
        .filter((c): c is Element => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
        .map((cell) => block(cell.children).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()),
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width === 0) return '';
    const pad = (row: string[]) => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
    const [head = [], ...body] = rows;
    return [pad(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(pad)].join('\n');
  }

  const start = main ?? find(root, (el) => el.tag === 'body')[0] ?? root;
  return block(start.children).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
