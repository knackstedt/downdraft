# Riichi Mahjong Tiles

Vector tile assets vendored from [fluffystuff/riichi-mahjong-tiles](https://github.com/fluffystuff/riichi-mahjong-tiles).

## License

All assets are in the **public domain** (see the upstream [LICENSE.md](https://github.com/fluffystuff/riichi-mahjong-tiles/blob/master/LICENSE.md)).

## Contents

- `regular/` — light variant (34 face tiles + `Front.svg` tile face).
- `black/` — dark variant (same set).

The 34 face tiles: `Man1-9`, `Pin1-9`, `Sou1-9` (the three suits), and the honors `Ton`, `Nan`, `Shaa`, `Pei` (winds), `Haku`, `Hatsu`, `Chun` (dragons).

Each SVG is 300×400 (portrait) and contains only the glyph with a transparent background — the tile face color is NOT in the SVG. The renderer fills each atlas slot with the tile face background color (cream `#f5f0eb` for light, dark `#1e1e1e` for dark, matching `Front.svg`) then draws the glyph with "contain" scaling (fit within the square, preserve aspect ratio, center) so the portrait glyph isn't distorted.
