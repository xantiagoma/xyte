// Mount the Zyte-compatible endpoint inside an existing Hono app: POST /zyte/v1/extract.
import { Hono } from 'hono';
import { createHandler, proxyFromEnv, Xyte } from '@xtandard/xyte';

const xyte = new Xyte({ proxy: proxyFromEnv() });
const app = new Hono();

app.get('/', (c) => c.text('my app'));
app.mount('/zyte', createHandler(xyte, { apiKeys: process.env.XYTE_API_KEYS?.split(',') }));

export default app; // Bun / Deno / Node via @hono/node-server
