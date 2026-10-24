import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { htmlToMarkdown, Xyte } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

const PAGE = `<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main>
  <article>
    <header><h1>Best   tacos &amp; burritos</h1><p>By <a href="/u/ana">Ana</a></p></header>
    <p>Visit <a href="/menu">the <b>menu</b></a> or call <code>555-0100</code>.<br>Open daily.
    <p>Second paragraph with <em>emphasis</em> &mdash; and an image <img src="/img/t.jpg" alt="taco [1]">.
    <ul>
      <li>Al pastor
      <li>Carnitas
        <ol start="3"><li>with lime</li><li>with onion</li></ol>
      </li>
      <li>Suadero</li>
    </ul>
    <table>
      <tr><th>Item</th><th>Price</th></tr>
      <tr><td>Taco</td><td>$3 | each</td></tr>
      <tr><td>Burrito</td></tr>
    </table>
    <pre><code class="language-js">const a = 1 &lt; 2;
console.log(a);</code></pre>
    <blockquote><p>Best in town.</p><p>— A fan</p></blockquote>
    <aside>Related: nothing</aside>
    <script>window.track()</script>
  </article>
</main>
<footer>© 2026</footer>
</body></html>`;

describe('htmlToMarkdown', () => {
  const md = htmlToMarkdown(PAGE, { url: 'https://tacos.example/blog/post' });

  test('main content only, without site chrome', () => {
    expect(md).not.toContain('About');
    expect(md).not.toContain('© 2026');
    expect(md).not.toContain('Related');
    expect(md).not.toContain('track');
    expect(md).not.toContain('color:red');
  });

  test('headings, inline formatting, entities and absolute links', () => {
    expect(md).toStartWith('# Best tacos & burritos\n\nBy [Ana](https://tacos.example/u/ana)');
    expect(md).toContain('Visit [the **menu**](https://tacos.example/menu) or call `555-0100`.  \nOpen daily.');
    expect(md).toContain('*emphasis* — and an image ![taco 1](https://tacos.example/img/t.jpg).');
  });

  test('lists, including unclosed <li> and nested ordered lists', () => {
    expect(md).toContain('- Al pastor\n- Carnitas\n  3. with lime\n  4. with onion\n- Suadero');
  });

  test('tables, padding short rows and escaping pipes', () => {
    expect(md).toContain('| Item | Price |\n| --- | --- |\n| Taco | $3 \\| each |\n| Burrito |  |');
  });

  test('code blocks keep their text and language', () => {
    expect(md).toContain('```js\nconst a = 1 < 2;\nconsole.log(a);\n```');
  });

  test('blockquotes', () => {
    expect(md).toContain('> Best in town.\n>\n> — A fan');
  });

  test('fullPage keeps everything', () => {
    const full = htmlToMarkdown(PAGE, { scope: 'fullPage' });
    expect(full).toContain('[About](/about)');
    expect(full).toContain('© 2026');
  });

  test('no main content found: the full page, as Zyte does', () => {
    const md = htmlToMarkdown('<body><nav><a href="/x">X</a></nav><div><p>Just text</p></div></body>');
    expect(md).toBe('[X](/x)\n\nJust text\n');
  });

  test('escapes markdown characters in text', () => {
    expect(htmlToMarkdown('<p>a_b *c* [d]</p>')).toBe('a\\_b \\*c\\* \\[d\\]\n');
  });
});

describe('markdown output', () => {
  let target: ReturnType<typeof startTarget>;
  beforeAll(() => {
    target = startTarget();
  });
  afterAll(() => target.stop());

  test('built in, from the HTTP body by default', async () => {
    const res = await new Xyte().extract({ url: `${target.base}/html`, markdown: true });
    expect(res.markdown).toBe('# hello\n');
    expect(res.httpResponseBody).toBeUndefined();
  });

  test('an extractor overrides the built-in', async () => {
    const res = await new Xyte({ extractors: { markdown: () => 'custom' } }).extract({ url: `${target.base}/html`, markdown: true });
    expect(res.markdown).toBe('custom');
  });

  test('markdown with serp is rejected', async () => {
    const error = await new Xyte().extract({ url: `${target.base}/html`, markdown: true, serp: true }).catch((e) => e);
    expect(error.status).toBe(400);
  });
});
