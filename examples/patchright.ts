// Stealthier rendering with patchright (npm i patchright && npx patchright install chrome).
import { chromium } from 'patchright';
import { decodo, Xyte } from '@xtandard/xyte';

const xyte = new Xyte({
  proxy: decodo({ username: process.env.DECODO_USERNAME!, password: process.env.DECODO_PASSWORD! }),
  browser: {
    browserType: chromium,
    launchOptions: { channel: 'chrome', args: ['--webrtc-ip-handling-policy=disable_non_proxied_udp'] },
    // Patchright's advice: let the real browser pick user agent and window size.
    contextOptions: ({ userAgent, viewport, ...defaults }) => ({ ...defaults, viewport: null }),
    blockResources: ['image', 'media', 'font'], // residential traffic is billed per GB
  },
});

const page = await xyte.extract({
  url: 'https://example.com',
  browserHtml: true,
  geolocation: 'GB',
  actions: [{ action: 'waitForSelector', selector: { type: 'css', value: 'body' } }],
});
console.log(page.browserHtml?.length);
await xyte.close();
