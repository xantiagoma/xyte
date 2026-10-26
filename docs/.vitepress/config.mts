import { defineConfig } from 'vitepress';

const repo = 'https://github.com/xantiagoma/xyte';
const npm = 'https://www.npmjs.com/package/@xtandard/xyte';
const site = 'https://me.xantiagoma.com/xyte/';
const description =
  "Zyte API's POST /v1/extract on any proxy provider, or none: a library, a CLI and a drop-in server.";

// Links the site can't serve point at the file on GitHub: `../src/…` from a docs page, and the
// repository files (`CHANGELOG.md`, `examples/`…) the README sections link to. `docs/x.md` links
// from the README are pages of this site.
const ROOT_FILES = /^(CHANGELOG\.md|LICENSE|NOTICE|SECURITY\.md|SUPPORT\.md|CONTRIBUTING\.md|CODE_OF_CONDUCT\.md|README\.md)(#.*)?$/;
const ROOT_DIRS = /^(examples|deploy|src|test|scripts|spec|\.github)(\/|$)/;
function rewrite(href: string): string {
  if (href.startsWith('../')) return `${repo}/blob/main/${href.slice(3)}`;
  if (href.startsWith('docs/')) return `./${href.slice(5)}`;
  if (ROOT_FILES.test(href) || ROOT_DIRS.test(href)) return `${repo}/blob/main/${href}`;
  return href;
}

export default defineConfig({
  title: 'xyte',
  description,
  lang: 'en',
  base: '/xyte/',
  cleanUrls: true,
  lastUpdated: true,
  // docs/README.md is the index for GitHub; the sidebar does that job here.
  srcExclude: ['README.md'],
  // Logo, favicons and the social image, shared with the README (docs/assets).
  vite: { publicDir: 'assets' },
  sitemap: { hostname: site },
  head: [
    ['link', { rel: 'icon', href: '/xyte/favicon.ico', sizes: '16x16 32x32 48x48' }],
    ['link', { rel: 'icon', href: '/xyte/favicon.png', type: 'image/png' }],
    ['link', { rel: 'apple-touch-icon', href: '/xyte/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#0B0F14' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'xyte' }],
    ['meta', { property: 'og:title', content: 'xyte: the Zyte API, on any proxy' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { property: 'og:image', content: `${site}social.png` }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { property: 'og:image:alt', content: 'xyte: the Zyte API, on any proxy' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  markdown: {
    config(md) {
      const render = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
      md.renderer.rules.link_open = (tokens, i, options, env, self) => {
        const href = tokens[i]!.attrGet('href');
        if (href) {
          const target = rewrite(href);
          tokens[i]!.attrSet('href', target);
          if (target.startsWith('http')) tokens[i]!.attrSet('target', '_blank');
        }
        return render(tokens, i, options, env, self);
      };
    },
  },
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide', activeMatch: '^/(guide|migrating-from-zyte|coverage)' },
      { text: 'Docs', link: '/routing', activeMatch: '^/(providers|routing|actions|browser|extraction|authentication|lifecycle|configuration|deploy|mounting|proxy-mode|observability)' },
      { text: 'API reference', link: '/api' },
      {
        text: 'v0.x',
        items: [
          { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
          { text: 'Releases', link: '/releases' },
          { text: 'npm', link: npm },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting started', link: '/guide' },
          { text: 'Migrating from Zyte', link: '/migrating-from-zyte' },
          { text: 'Zyte API coverage', link: '/coverage' },
        ],
      },
      {
        text: 'Using it',
        items: [
          { text: 'Providers', link: '/providers' },
          { text: 'Combining providers', link: '/routing' },
          { text: 'Browser rendering', link: '/browser' },
          { text: 'Actions', link: '/actions' },
          { text: 'AI extraction', link: '/extraction' },
          { text: 'Logged-in pages', link: '/authentication' },
          { text: 'Lifecycle and closing', link: '/lifecycle' },
        ],
      },
      {
        text: 'Running it',
        items: [
          { text: 'Configuration', link: '/configuration' },
          { text: 'Deploying', link: '/deploy' },
          { text: 'Mounting in your app', link: '/mounting' },
          { text: 'Proxy mode', link: '/proxy-mode' },
          { text: 'Observability', link: '/observability' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API reference', link: '/api' },
          { text: 'Releases', link: '/releases' },
          { text: 'About and disclaimer', link: '/about' },
        ],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: npm },
    ],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: {
      message: 'MIT licensed. A personal project, not affiliated with Zyte Group Ltd (<a href="/xyte/about#disclaimer">disclaimer</a>).',
      copyright: 'Copyright © 2026 Santiago Montoya',
    },
  },
});
