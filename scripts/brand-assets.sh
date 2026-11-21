#!/bin/sh
# Rebuild the brand kit in docs/assets/ (see docs/BRAND.md): the SVG masters from
# scripts/brand-svg.ts, then the three rasters built from them.
# Needs hb-view (harfbuzz), rsvg-convert (librsvg) and magick (ImageMagick 7); oxipng when installed.
# The wordmark is Urbanist (OFL 1.1), downloaded from google/fonts into a cache directory, never
# committed (URBANIST=/path/to/Urbanist.ttf overrides it). The SVGs contain only paths.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${URBANIST:-}" ]; then
  fonts="${XDG_CACHE_HOME:-$HOME/.cache}/xyte-brand"
  mkdir -p "$fonts"
  [ -s "$fonts/Urbanist.ttf" ] ||
    curl -fsSLo "$fonts/Urbanist.ttf" "https://github.com/google/fonts/raw/main/ofl/urbanist/Urbanist%5Bwght%5D.ttf"
  URBANIST="$fonts/Urbanist.ttf"
fi
URBANIST="$URBANIST" bun "$root/scripts/brand-svg.ts"

cd "$root/docs/assets"
# Everything people see on a page uses the SVGs. Rasters only where a format requires one:
# apple-touch-icon.png and favicon.ico (<head> fallbacks) and social.png (og:image).
rsvg-convert -w 180 -h 180 favicon.svg -o apple-touch-icon.png
tmp=$(mktemp -d)
for s in 16 32 48; do rsvg-convert -w $s -h $s favicon.svg -o "$tmp/f$s.png"; done
magick "$tmp/f16.png" "$tmp/f32.png" "$tmp/f48.png" favicon.ico
rm -rf "$tmp"
rsvg-convert -w 1280 -h 640 social.svg -o social.png

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o max ./*.png; fi
echo "brand kit rebuilt"
