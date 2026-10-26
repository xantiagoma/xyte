# Getting started

xyte implements [Zyte API](https://docs.zyte.com/zyte-api/usage/index.html)'s `POST /v1/extract`
on any proxy provider, or none. It runs on **Node.js ≥ 22** and **Bun**.

```sh
npm i @xtandard/xyte
# browser requests (browserHtml, screenshot, actions, networkCapture):
npm i playwright && npx playwright install chromium
# proxies on Node.js (Bun has proxy support built into fetch); undici 8 needs Node 22.19+:
npm i undici
```

The command it installs is `xyte`.

<!--@include: ../README.md#guide-->
