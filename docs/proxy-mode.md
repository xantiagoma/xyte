# Proxy mode

Zyte API also works as an HTTP proxy (`api.zyte.com:8011`): code that already talks to a proxy
service (Scrapy with `scrapy-zyte-smartproxy`, `requests` with `proxies=`, curl `-x`) uses it
without changing how it builds requests. xyte serves the same:

```sh
XYTE_PROVIDER=oxylabs … xyte serve --proxy-port 8012     # next to the HTTP API on 8011
xyte ca > xyte-ca.crt                                    # the certificate clients trust

curl -x http://127.0.0.1:8012 -U KEY: --cacert xyte-ca.crt https://toscrape.com
curl -x http://127.0.0.1:8012 -U KEY: --cacert xyte-ca.crt -H 'Zyte-Browser-Html: true' https://toscrape.com
```

Each request becomes an `extract()` through your providers, combinators, cache and rate limits,
and the answer is the site's own response: its status, headers and body (decompressed), plus
`Zyte-Request-ID`.

## Request headers

As on Zyte, options go in `Zyte-*` headers (removed before the request reaches the site):

| Header | Sets |
| --- | --- |
| `Zyte-Browser-Html: true` | `browserHtml`: the rendered page as the body |
| `Zyte-Geolocation` | `geolocation` |
| `Zyte-Device` | `device` |
| `Zyte-IPType` | `ipType` |
| `Zyte-Session-ID` | `session.id` |
| `Zyte-Cookie-Management` | `cookieManagement` |
| `Zyte-Disable-Follow-Redirect: true` | `followRedirect: false` (not with `Zyte-Browser-Html`) |
| `Zyte-JobId` | `jobId` |
| `Zyte-Tags` | `tags`, as a JSON object |
| `Zyte-Override-Headers` | which of `Accept`, `Accept-Encoding`, `User-Agent` to send as given; otherwise xyte's own are used, as Zyte does |

Other headers are forwarded. `Cookie` becomes `requestCookies` for the target's domain only (as
on Zyte). Requests carrying `X-Forwarded-For`, `Via`, `X-Real-IP`-style headers (Zyte's list) are
rejected with a 400. The proxy username is the API key (`XYTE_API_KEYS`); a wrong one is a 407.

## Errors

A failure (a ban after retries, an invalid request…) answers with the Zyte problem's status, the
problem as a JSON body, and `Zyte-Error-Type` / `Zyte-Error-Title` headers. A target's own 4xx/5xx
is passed through as is.

## HTTPS and the CA

To apply bans, retries and providers to HTTPS traffic, the proxy has to read it: for each site it
presents a certificate signed by its own certificate authority, which clients must trust. Zyte
works the same way with its CA certificate.

- **The CA must stay the same** across restarts and instances, or clients stop trusting the
  proxy. `xyte serve` takes it from `XYTE_CA_CERT` / `XYTE_CA_KEY` (PEM, or paths to PEM files: use
  secrets for these in a deployment), else from `XYTE_CA_DIR` (default `~/.xyte`), where it's
  created on first use (`ca.key` is written with mode 600).
- **`xyte ca`** prints the certificate. Install it where your client looks: `curl --cacert`,
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` for Python, the OS trust store.
- **The key is sensitive:** anyone holding it can impersonate any site to clients that trust it.
  Keep it out of images and repos.

Certificates are P-256 ECDSA, generated with `node:crypto` (no dependencies), one per site, cached.

## Library

```ts
import { serveProxyMode, Xyte } from '@xtandard/xyte';

const proxy = await serveProxyMode(new Xyte({ proxy: … }), { apiKeys: ['KEY'], port: 8012, ca });
proxy.caCert; // PEM for clients
```

`attachProxyMode(server, xyte, options)` adds it to an existing `node:http` server.

## Deploying

Proxy mode needs a raw TCP port: clients send `CONNECT` and absolute-URL requests, which managed
HTTP platforms (Cloud Run, App Platform, Render's web services) don't pass through their front
end. Run it where the port is yours: Fly.io (a TCP service), a VM, Kubernetes, `docker run -p
8012:8012`.

## Compared with Zyte

As in Zyte's proxy mode, screenshots, actions, network capture and extraction aren't available:
use the HTTP API for those. There's no HTTPS proxy interface (Zyte's `:8014`, where the client
talks TLS to the proxy itself); the plain-HTTP proxy port handles `https://` targets.
