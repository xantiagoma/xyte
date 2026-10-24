// Mount inside an existing Express app: POST /zyte/v1/extract.
import express from 'express';
import { createHandler, proxyFromEnv, toNodeHandler, Xyte } from 'xyte';

const xyte = new Xyte({ proxy: proxyFromEnv() });
const app = express();

app.use(express.json({ limit: '5mb' })); // fine: toNodeHandler re-serializes a parsed body
app.use('/zyte', toNodeHandler(createHandler(xyte, { apiKeys: process.env.XYTE_API_KEYS?.split(',') })));

app.listen(Number(process.env.PORT ?? 3000));
