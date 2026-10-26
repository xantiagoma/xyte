# Releases

## Versioning: ZeroVer (`0.x.y`)

xyte follows [ZeroVer](https://0ver.org): the major version stays at `0`. Within `0.x`, versions
follow [SemVer](https://semver.org) the way npm reads `0.x` ranges (`^0.4.1` allows `0.4.x`, not
`0.5.0`):

- **Minor** (`0.x.0`): breaking changes.
- **Patch** (`0.x.y`): fixes and backwards-compatible additions.

So `^0.x.y` gets you fixes without breakage. Read the [changelog](../CHANGELOG.md) before moving
to a new minor.

## Releasing

Commits on `main` are [conventional commits](https://www.conventionalcommits.org): `feat(scope): …`,
`fix: …`, `docs: …`, `feat!: …` for a breaking change. Then:

```sh
bun run release   # changelogen --release --push
```

[changelogen](https://github.com/unjs/changelogen) picks the version from the commits since the
last tag (on `0.x`: a `feat` or `fix` is a patch, a breaking change a minor; `--minor` forces one),
writes `CHANGELOG.md`, commits `chore(release): vX.Y.Z`, tags it and pushes. The tag starts the
[Release workflow](../.github/workflows/release.yml), which:

1. runs the same checks as CI (typecheck, tests with Redis and browsers, the generated docs, the
   Node.js smoke tests, [publint](https://publint.dev));
2. checks that the tag matches `package.json`;
3. publishes to npm through **trusted publishing** (OIDC: no token stored anywhere), with
   [provenance](https://docs.npmjs.com/generating-provenance-statements) that links the package to
   the workflow run that built it;
4. creates the GitHub release.

A publish that failed for an existing tag is re-run by hand, without a new version:
`gh workflow run release.yml -f tag=vX.Y.Z`. A version already on npm is skipped.

## Trusted publishing (once)

npm attaches the trust to an existing package, so v0.1.0 was published by hand and the trust set
up after it:

```sh
bunx npm@latest login --auth-type=web
bunx npm@latest publish --access public --otp=<code>
bunx npm@latest trust github xyte --repo xantiagoma/xyte --file release.yml --allow-publish -y --otp=<code>
```

`npm trust` needs npm 11.10 or later, hence `npm@latest`. The trust names the workflow file:
renaming `release.yml` breaks publishing until the trust is updated.

## What's in the package

`dist/` (ESM and type declarations; the CLI is `dist/cli.mjs`), `docs/`, `README.md`, `LICENSE`.
