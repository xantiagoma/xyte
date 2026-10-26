# Security policy

xyte holds proxy and API credentials, fetches whatever URLs it is given, and can run as a server
other code calls. Reports are taken seriously; thank you for reporting responsibly.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**, or go to
[github.com/xantiagoma/xyte/security/advisories/new](https://github.com/xantiagoma/xyte/security/advisories/new).
Only the maintainer can see the report.

Please include:

- the version (`npm ls @xtandard/xyte`, or the image tag), and the runtime (Node.js or Bun, and
  its version);
- how xyte is used: library, `xyte serve`, a handler mounted in your app, proxy mode;
- the relevant configuration, with every secret removed;
- a request that reproduces the problem, and what happens;
- the impact as you understand it.

What to expect: an acknowledgement within 7 days and an assessment within 14 days. We agree on a
disclosure date with you, normally once a fix is released and no later than 90 days after the
report. A fix ships as a patch release of the latest `0.x` minor, with a GitHub security
advisory (and a CVE where one applies). You are credited in the advisory unless you ask not to
be. This is a one-maintainer project: these are goals, not contractual deadlines.

## Supported versions

Versions follow [ZeroVer](https://0ver.org) (`0.MINOR.PATCH`). Only the **latest minor line**
gets security fixes, as a new patch release. Upgrade to the latest patch of the latest minor.

| Version | Supported |
| --- | --- |
| latest `0.MINOR.x` (today: `0.1.x`) | yes |
| any older line | no |

## Scope

In scope:

- **Credential leaks.** Proxy, provider, Zyte, LLM, captcha-solver or Redis credentials showing
  up in responses, problem `detail`s, request reports, logs, `X-Xyte-*` headers, stats or job
  records.
- **Server authentication.** Getting past `XYTE_API_KEYS` / `apiKeys` on `/v1/extract`,
  `/v1/jobs`, the Stats API or proxy mode; `xyte serve` listening publicly without keys when it
  shouldn't.
- **Server-side request forgery** past `blockPrivateTargets` (on in `xyte serve`): a target URL
  or a job `callbackUrl` that reaches loopback, private, link-local or cloud-metadata addresses
  through an IP literal or an internal name the check is meant to catch.
- **Proxy mode's CA.** Leaking the CA's private key, or certificates issued for more than the
  connection needs.
- **Jobs.** Forging `X-Xyte-Signature`, or guessing a job's ID. (Jobs aren't separated per API
  key: any valid key can read a job whose ID it knows.)
- **Resource exhaustion past the limits**: request bodies over `maxBodyBytes`, or a request that
  makes xyte use far more memory than its response size explains.
- **Code execution** through request fields: `actions`, `evaluate`, custom headers, markdown or
  extraction options doing more than documented.

Out of scope:

- **What the browser runs.** Pages, and the `evaluate` scripts you send, run in the browser by
  design. Only expose `xyte serve` to callers you trust with that.
- **What `blockPrivateTargets` doesn't check yet.** It checks the request's URL and the job's
  `callbackUrl`, by IP literal and internal name. It doesn't check DNS answers (a public name
  that resolves to a private address), redirects, `goto` actions, or what a page loads in the
  browser. Behind a proxy provider, only the proxy's network is reachable; with `direct()` on a
  server, isolate the container's network (see Hardening).
- Configurations the docs warn against: `XYTE_ALLOW_ANONYMOUS=true` or
  `XYTE_ALLOW_PRIVATE_TARGETS=true` on a public endpoint, keys shared in URLs or committed to
  repositories.
- Vulnerabilities in Playwright, Chromium, patchright, Node.js, Bun or a provider's service:
  report them upstream (and here too, if xyte makes one worse).
- Volumetric denial of service, and the cost of requests your own keys allow.
- Findings from automated scanners without a working proof of concept.

## Hardening

When you run xyte as a server:

- set `XYTE_API_KEYS` and keep the keys out of URLs and logs;
- keep `blockPrivateTargets` on and run the container on a network without access to your
  internal services;
- give it its own provider credentials with spending limits, and use `budget()` where the
  provider allows it;
- set `XYTE_WEBHOOK_SECRET` if you use job callbacks, and verify signatures with
  `verifyWebhook()`;
- keep the dependencies (Playwright and its browsers) up to date.
