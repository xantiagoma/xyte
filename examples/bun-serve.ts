// Bun.serve with routes: the endpoint next to your own.
import { createHandler, proxyFromEnv, Xyte } from 'xytejs';

const extract = createHandler(new Xyte({ proxy: proxyFromEnv() }));

Bun.serve({
  port: Number(process.env.PORT ?? 8011),
  idleTimeout: 255, // scrapes take longer than Bun's 10 s default
  routes: {
    '/v1/extract': { POST: extract },
    '/healthz': () => new Response('ok'),
  },
});
