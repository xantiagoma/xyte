---
layout: home
title: xyte
titleTemplate: The Zyte API, on any proxy

hero:
  name: xyte
  text: The Zyte API, on any proxy
  tagline: "Same request JSON, same response JSON, same error codes as Zyte's POST /v1/extract. Traffic exits through Oxylabs, Bright Data, ZenRows, any proxy URL, no proxy at all, or Zyte itself."
  image:
    light: /lockup-stacked-light.svg
    dark: /lockup-stacked-dark.svg
    alt: '@xtandard/xyte'
  actions:
    - theme: brand
      text: Get started
      link: /guide
    - theme: alt
      text: Migrating from Zyte
      link: /migrating-from-zyte
    - theme: alt
      text: GitHub
      link: https://github.com/xantiagoma/xyte

features:
  - icon: 🔌
    title: Zyte-compatible
    details: "httpResponseBody, browserHtml, screenshot, actions, networkCapture, geolocation, sessions, cookies, markdown and Zyte's error types. Point existing Zyte code at it by changing the base URL."
    link: /coverage
    linkText: What's covered
  - icon: 🌍
    title: Any exit
    details: "Presets for 30+ proxy networks and scraping APIs, any http://user:pass@host:port, direct(), or Zyte as one more provider."
    link: /providers
    linkText: Providers
  - icon: 🔀
    title: Fallbacks and routing
    details: "rotate, route per site, adaptive (learns which exit works where), circuit breakers, budgets and usage checks, with shared state in Redis."
    link: /routing
    linkText: Combining providers
  - icon: 🧭
    title: Browser rendering
    details: "Playwright, patchright and other stealth forks, remote browsers, actions, network capture and captcha solvers."
    link: /browser
    linkText: Browser
  - icon: 🧠
    title: AI extraction
    details: "product, article, jobPosting and customAttributes in Zyte's schemas, through any OpenAI-compatible LLM."
    link: /extraction
    linkText: Extraction
  - icon: 🚀
    title: Library, CLI or server
    details: "new Xyte().extract() in Node.js 22+ or Bun, xyte serve as a drop-in endpoint, a handler for Hono, Express or Next.js, or Zyte's proxy mode."
    link: /deploy
    linkText: Deploying
---

## Install

```sh
npm i @xtandard/xyte
```

```ts
import { Xyte, oxylabs, decodeBody } from '@xtandard/xyte';

const xyte = new Xyte({
  proxy: oxylabs({ username: process.env.OXYLABS_USERNAME!, password: process.env.OXYLABS_PASSWORD! }),
});
const page = await xyte.extract({ url: 'https://example.com', httpResponseBody: true, geolocation: 'US' });
console.log(decodeBody(page.httpResponseBody!));
```

Or as a server that existing Zyte code calls:

```sh
XYTE_PROVIDER=oxylabs OXYLABS_USERNAME=… OXYLABS_PASSWORD=… npx @xtandard/xyte serve --port 8011
```

## Why it exists

xyte is a personal project: a library that makes one scraping flow easier to write. One request
format for every exit, fallbacks from a cheap exit to a better one when a site bans, and the same
code whether the request goes to Zyte, to a proxy, or nowhere special. It speaks Zyte's API
because that API is well designed and well documented, so code moves between xyte and Zyte in
either direction. It doesn't try to compete with or replace Zyte, which is one of its providers,
and it isn't affiliated with Zyte ([disclaimer](./about#disclaimer)).

## The xtandard ecosystem

xyte has siblings: open-source, MIT-licensed projects that share the xtandard name. Each one
stands on its own.

<div class="ecosystem-cards">
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard/" target="_blank">
    <strong>@xtandard/lib</strong>
    <span>Lightweight, type-safe TypeScript utilities with a zero-dependency core.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-flags/" target="_blank">
    <strong>@xtandard/flags</strong>
    <span>Self-hosted, embeddable, OpenFeature-compatible feature flags with pluggable storage.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-webhooks/" target="_blank">
    <strong>@xtandard/webhooks</strong>
    <span>Self-hosted, Standard Webhooks-compliant outbound webhooks: a Svix alternative as a library.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-audit/" target="_blank">
    <strong>@xtandard/audit</strong>
    <span>Self-hosted, tamper-evident audit logs for B2B SaaS: a WorkOS Audit Logs alternative as a library.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-links/" target="_blank">
    <strong>@xtandard/links</strong>
    <span>Self-hosted branded short links with click analytics, conversions and deep links: a Dub alternative as a library.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-entitlements/" target="_blank">
    <strong>@xtandard/entitlements</strong>
    <span>Plans, entitlements and usage metering for TypeScript apps, as a library.</span>
  </a>
  <a class="ecosystem-card" href="https://me.xantiagoma.com/xtandard-image/" target="_blank">
    <strong>xtandard-image</strong>
    <span>Self-hosted image and video processing in Go and libvips, with imgproxy-compatible URLs.</span>
  </a>
</div>

All of them, with npm and GitHub links: [the xtandard ecosystem](./ecosystem).
