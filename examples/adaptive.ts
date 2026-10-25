// Let xyte learn, per site, the cheapest exit that works: free first, a residential proxy next,
// Zyte last, with a circuit breaker on the proxy and a cap on what Zyte can spend.
// See docs/routing.md.
import { adaptive, budget, decodeBody, direct, healthy, oxylabs, Xyte, zyteApi } from 'xyte';

const smart = adaptive([
  direct(),
  healthy(oxylabs({ username: process.env.OXYLABS_USERNAME!, password: process.env.OXYLABS_PASSWORD! }), { failures: 5, cooldown: 60 }),
  budget(zyteApi({ apiKey: process.env.ZYTE_API_KEY! }), { max: 500, per: 'hour' }),
]);

const xyte = new Xyte({
  proxy: smart,
  retries: 4, // room to climb from direct to Zyte while a site is being learned
  browserFallback: true, // a JavaScript challenge on a plain GET is retried in a browser
  onAttempt: ({ provider, result, ms, url }) => console.log(`${new URL(url).hostname} ${provider} ${result} ${ms} ms`),
});

for (const url of ['https://restaurantguru.com/Dante-Italian-Sandwich-Vancouver', 'https://example.com/']) {
  const page = await xyte.extract({ url, httpResponseBody: true }).catch((error) => error);
  console.log(url, page.statusCode ?? page.status, page.httpResponseBody ? decodeBody(page.httpResponseBody).length : '');
}
console.log(smart.scores());
await xyte.close();
