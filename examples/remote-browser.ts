// Render in a hosted browser per request instead of a local Chromium.
import { Xyte } from 'xyte';

const xyte = new Xyte({
  browser: {
    // Browserless: it proxies itself; the country comes from the request's geolocation.
    connect: ({ country }) =>
      `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}` +
      (country ? `&proxy=residential&proxyCountry=${country.toLowerCase()}` : ''),
  },
});

const page = await xyte.extract({ url: 'https://example.com', browserHtml: true, geolocation: 'US' });
console.log(page.statusCode);
await xyte.close();
