// Library use: the same request JSON as api.zyte.com/v1/extract, through any proxy.
import { decodeBody, oxylabs, rotate, Xyte, XyteError, zenrows } from 'xyte';

const xyte = new Xyte({
  // Oxylabs first; a retry goes through ZenRows (survives one provider being down).
  proxy: rotate([
    oxylabs({ username: process.env.OXYLABS_USERNAME!, password: process.env.OXYLABS_PASSWORD! }),
    zenrows({ apiKey: process.env.ZENROWS_API_KEY! }),
  ]),
  concurrency: 10,
});

try {
  const page = await xyte.extract({ url: 'https://example.com', httpResponseBody: true, geolocation: 'US' });
  console.log(page.statusCode, decodeBody(page.httpResponseBody!).length);
} catch (error) {
  if (error instanceof XyteError && error.status === 520) console.error('banned or proxy down after retries');
  else throw error;
} finally {
  await xyte.close();
}
