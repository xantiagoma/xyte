// A provider per site: free where the site lets anyone in, residential where it doesn't, Zyte
// only where nothing else gets through. See docs/routing.md.
import { decodeBody, direct, oxylabs, rotate, route, Xyte, zyteApi } from 'xytejs';

const residential = oxylabs({ username: process.env.OXYLABS_USERNAME!, password: process.env.OXYLABS_PASSWORD! });
const zyte = zyteApi({ apiKey: process.env.ZYTE_API_KEY! });

const xyte = new Xyte({
  proxy: route(
    {
      'wolt.com': direct(),
      'yelp.co.uk': direct(),
      'restaurantguru.com': rotate([residential, zyte]), // Zyte only after a ban
      'doordash.com': zyte,
    },
    residential, // every other site
  ),
  onRetry: ({ attempt, url, reason }) => console.warn(`retry ${attempt} ${url}: ${reason}`),
});

const page = await xyte.extract({ url: 'https://restaurantguru.com/Dante-Italian-Sandwich-Vancouver', httpResponseBody: true });
console.log(page.statusCode, decodeBody(page.httpResponseBody!).length);
await xyte.close();
