// Next.js App Router: app/api/zyte/v1/extract/route.ts → POST /api/zyte/v1/extract.
// Needs the Node.js runtime (proxies, browser); not the Edge runtime.
import { createHandler, proxyFromEnv, Xyte } from 'xytejs';

export const runtime = 'nodejs';
export const maxDuration = 120;

const handler = createHandler(new Xyte({ proxy: proxyFromEnv() }), { apiKeys: process.env.XYTE_API_KEYS?.split(',') });

export const POST = (request: Request): Promise<Response> => handler(request);
