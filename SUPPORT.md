# Getting help

xyte is a personal project, maintained by one person in their spare time and provided as is
([disclaimer](README.md#disclaimer)). There is no paid support and no SLA; help is best effort.
These are the places to go, in order:

1. **Docs first.** The [README](README.md) and [docs/](docs/README.md):
   - [configuration](docs/configuration.md): every option, environment variable and CLI flag;
   - [providers](docs/providers.md) and [combining providers](docs/routing.md);
   - [browser](docs/browser.md), [actions](docs/actions.md), [lifecycle](docs/lifecycle.md);
   - [coverage](docs/coverage.md): which Zyte API fields are implemented;
   - [migrating from Zyte](docs/migrating-from-zyte.md) and [deploying](docs/deploy.md);
   - the [API reference](docs/api.md), every export.

   `xyte doctor` checks each configured provider (credentials, exit IP and country, quota). Every
   error is a Zyte problem (`type`, `status`, `detail`), and the `detail` usually says what to fix.
2. **Search the [issues](https://github.com/xantiagoma/xyte/issues)**, open and closed.
3. **Open an issue.** Use the
   [bug report](https://github.com/xantiagoma/xyte/issues/new?template=bug_report.yml) template for
   something broken, and the
   [feature request](https://github.com/xantiagoma/xyte/issues/new?template=feature_request.yml)
   template for a missing Zyte field, provider or option. Questions are welcome as issues too.
   Include your version, runtime (Node.js or Bun), provider and the request JSON, **with
   credentials removed**.

A **security vulnerability** never goes in an issue. Report it privately, as
[SECURITY.md](SECURITY.md) explains.

Problems with a provider's network, account, billing or blocks are for that provider's support;
problems with Zyte's own service are for [Zyte's support](https://support.zyte.com). xyte can't
fix either.
