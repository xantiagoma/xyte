# Brand

The xyte mark is the family's lime **X** (a `>` chevron and two arms between grey angle brackets).
Its upper-right arm is a **route**: it ends in an arrowhead, the request going out, and a grey branch
leaves it for a second node, another provider to fall back to. Any proxy, one request shape. It comes
as an app icon, a bare mark and wordmark lockups. Everything lives in [`docs/assets/`](assets/); the
SVGs are the masters, and they are what every page shows. The only rasters are the three a format
requires: `favicon.ico` and `apple-touch-icon.png` (`<head>` fallbacks) and `social.png` (`og:image`).

It belongs with its siblings. The near-black rounded tile, the orbit lines, the grey brackets and the
lime X are shared with `@xtandard/flags` (a flag on the arm), `@xtandard/webhooks` (a hook),
`@xtandard/entitlements` (a gauge) and the rest. The layout of the lockups and the social card
follows `xtandard-image`'s kit. The route is what makes it xyte; it keeps the idea of the first,
raster logo (a lime path with an arrow crossing a grey one that ends in a node).

## Files

| File | What it is | Use it for |
| --- | --- | --- |
| `logo.svg` | App icon: the mark on a near-black rounded square with faint orbit lines | Only where an app-icon shape is expected (avatars, the repository picture); never as a logo on a page |
| `symbol-dark.svg`, `symbol-light.svg` (`symbol.svg` = dark) | The mark with brackets, transparent: no tile, each with its surface's gradient and greys | Any bare logo on a page (admin UIs, embeds); pick the variant for the surface |
| `lockup-horizontal-dark.svg` | Mark + wordmark, `@xtandard/` in near-white | Headers on dark backgrounds (README in GitHub dark mode, the docs site in dark mode) |
| `lockup-horizontal-light.svg` | Mark + wordmark, `@xtandard/` in ink, deeper lime | Headers on light backgrounds (README in light mode, the docs site in light mode) |
| `lockup-stacked-{dark,light}.svg` | Mark left, `@xtandard/` over `xyte` | The docs home hero (light/dark); square-ish slots: slides, sidebars |
| `monochrome-white.svg`, `monochrome-black.svg` | One-colour horizontal lockup | Photos and busy backgrounds (white); print (black) |
| `favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png` (180) | The icon without orbit lines and shadow, which do not survive 16 px | Browser tabs: the docs site (`favicon.svg` first; the ICO and PNG are fallbacks for browsers and iOS) |
| `social.svg`, `social.png` (1280×640) | Social card: icon, wordmark, tagline, `bun add` line | GitHub social preview (Settings → Social preview, uploaded by hand), `og:image` of the docs site |

Rebuild after editing:

```sh
sh scripts/brand-assets.sh   # SVG masters, then the three rasters (hb-view, rsvg-convert, magick; oxipng if installed)
```

`scripts/brand-svg.ts` holds the geometry (one 1024-unit grid) and shapes the wordmark with HarfBuzz;
`scripts/brand-assets.sh` runs it and builds the rasters. Urbanist comes from
[google/fonts](https://github.com/google/fonts/tree/main/ofl/urbanist) into `~/.cache/xyte-brand/`
on the first run (`URBANIST=/path/to/Urbanist.ttf` uses a local copy).

### Where each file goes

- **README header**: a `<picture>` choosing `lockup-horizontal-dark.svg` / `lockup-horizontal-light.svg`
  with `prefers-color-scheme`, by absolute `raw.githubusercontent.com` URL (the README ships to npm,
  which does not ship `docs/assets/`).
- **Docs site** (VitePress serves `docs/assets/` as its public folder): the horizontal lockup SVGs as
  the nav logo (light/dark, with the text title hidden), `lockup-stacked-light.svg` / `lockup-stacked-dark.svg`
  as the home hero image (light/dark), as in `xtandard-audit`; no tile on any page,
  `favicon.svg` + `favicon.ico` + `apple-touch-icon.png`, and `social.png` as `og:image`.

## Palette

Lime on charcoal, as in the family. Lime is an artwork colour on dark surfaces; on white use the
deeper lime for text.

| Token | Hex | Role | Contrast on white / on ink |
| --- | --- | --- | --- |
| `xy-lime-hi` | `#D9F99D` | Top-left of the mark gradient, the social-card tagline | 1.18 / 15.9 |
| `xy-lime` | `#A3E635` | The mark, accents and links on dark surfaces | 1.55 / 12.1 |
| `xy-lime-deep` | `#65A30D` | Bottom-right of the mark gradient | 2.9 / 6.5 |
| `xy-lime-text` | `#4D7C0F` | Accent text and the wordmark's end on light surfaces (AA) | 5.0 / 3.8 |
| `xy-ink` | `#0F1215` | Icon surface, `@xtandard/` on light, `theme-color` | 18.8 / — |
| `xy-orbit` | `#4E5459` | Orbit lines and dots | 7.7 / 2.5 |
| `xy-bracket` | `#5B6167` | The angle brackets | 6.3 / 3.0 |
| `xy-route` | `#7A828A` (dark), `#9AA1A8` (light) | The grey branch and its node | — |
| `xy-slate` | `#8B939C` | Secondary text on ink (the social-card command) | 3.1 / 6.0 |
| `xy-paper` | `#FAFAFA` | `@xtandard/` on dark | 1.04 / 18.0 |

### Gradients

Lit from the top left, as in every xtandard mark.

| Shape | Stops |
| --- | --- |
| Mark (X + arrow), dark surfaces | `#D9F99D` → `#A3E635` 42% → `#65A30D`, top left to bottom right |
| Mark, light surfaces | `#A3E635` → `#84CC16` 42% → `#4D7C0F` |
| `xyte` (wordmark), dark | `#D9F99D` → `#A3E635`, top to bottom |
| `xyte` (wordmark), light | `#84CC16` → `#4D7C0F` |
| Icon surface | `#1A1C1F` → `#08090B`, top to bottom, with a 4-unit white rim at 14% → 3% opacity |

## Wordmark

`@xtandard/xyte`, the npm name, in **Urbanist** Black (900), shaped by HarfBuzz and converted to
paths (the SVGs need no font), the same face as the siblings. The siblings' repositories are named
`xtandard-<name>` and their wordmarks follow; this one is `xyte` on GitHub and on the docs site, so
the wordmark uses the package name instead. `@xtandard/` is paper on dark and ink on light; `xyte`
is always the lime gradient. The social card adds Urbanist SemiBold (600) for the tagline and
JetBrains Mono for the command. Both fonts are SIL OFL 1.1; the SVGs contain glyph outlines, not
font software.

## Geometry

One 1024-unit grid. The chevron is `M250 300 L395 300 L560 512 L395 724 L250 724 L415 512 Z`; the
arms run along the same diagonals (slope 165/212) with a 46-unit gap. The upper arm continues as an
arrowhead along its diagonal: base 236 units wide, 150 long, with a 28-unit notch. The branch leaves
the arm's centre line at y = 410, at a right angle to the arm, and ends 175 units out in a 38-unit
node. In the app icon the mark is scaled by 0.86 and centred; the tile's corner radius is 224 (21.9%).

In the horizontal lockups the symbol is vertically centred on the wordmark's optical centre: the
middle of its cap height (baseline to cap height, descenders ignored) sits on the symbol's vertical
centre, the same rule as in every xtandard lockup. The stacked lockups keep the X's base on the
second line's baseline.

**Clear space**: the arrowhead's length on every side of the mark or a lockup. **Minimum sizes**: app
icon 16 px (use the favicon set below 48 px), horizontal lockup 24 px high, stacked lockup 48 px high.

## Do and don't

Do:

- Use the dark lockup on dark backgrounds and the light one on light; on GitHub switch with
  `<picture>` and `prefers-color-scheme`.
- Show the tile only where an app-icon shape is expected (favicons, the apple-touch icon, the social
  card, avatars). On pages use the symbol or a lockup, which have no tile.
- Use the monochrome lockups on photos or in print.

Don't:

- Recolour the mark (it is lime like flags and webhooks; blue belongs to xtandard-image).
- Detach the arrowhead or the branch from the arm, move them to another arm, or colour the branch
  lime (the grey is the point: the route not taken, until it is).
- Put the dark lockup on a light background or vice versa; stretch, rotate or add effects.
- Set the wordmark in another font or as live text.
