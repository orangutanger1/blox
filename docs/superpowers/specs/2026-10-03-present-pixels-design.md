# Present pixel checks

Status: self-approved design (unattended run 2026-10-03). Queue item 5.

## Problem

`present lint` checks a thumbnail's file header (16:9) and catches
byte-identical copies, but it never looks at the pixels. A render can still
pass when it is:

- a black or grey frame (camera inside a wall, sky only, a failed capture);
- washed-out fog with no contrast;
- framed differently from another thumbnail but showing the same picture.

Store thumbnails sell the game, so these are real failures.

## Live facts

Captures written by `present render` are 1466×825 **baseline JPEG** (JFIF,
3 components, Huffman tables standard). Users may drop in PNGs.

## Design

**Decoding, no new dependency.**
- JPEG (baseline, Huffman, 8-bit, 1 or 3 components, any sampling): decode
  **DC coefficients only**. AC coefficients are Huffman-decoded and
  discarded, with no IDCT. Each 8×8 block's DC is its mean, so the result is
  an exact 1/8-scale image, which is all these statistics need.
  Progressive/arithmetic JPEGs → "not checked" warning.
- PNG (8-bit, colour types 0/2/4/6, non-interlaced) decodes via
  `node:zlib` inflate and the five scanline filters. The decoder then
  downscales to about 1/8.
- Output: `{w, h, luma: Float32Array, rgb: Float32Array}` at small size.

**Rules** (new `PresentRule`s; each thumbnail and the icon):

| Rule | Check | Severity |
|---|---|---|
| `thumb-blank` | luma standard deviation < 8 (of 255): one flat colour | error |
| `thumb-contrast` | luma p95 − p5 < 48: washed out or murky | warn |
| `thumb-dark` / bright | mean luma < 35 or > 225 | warn (reported under `thumb-contrast`) |
| `thumb-similar` | 16×9 colour-grid mean absolute difference < 10 (of 255) to an earlier thumbnail (not byte-identical) | error |

`thumb-similar` uses a 16×9 grid of box-averaged colours from the downscaled image.
Ruling from calibration on real captures: the first design used a 16×9
average hash with Hamming distance ≤ 6. Two genuinely different shots
(sky above ground) scored 9, so luma-only hashing is too coarse. Colour-grid
differences between distinct shots measured 24–58. Byte-identical images keep their existing
`thumb-duplicate` rule.

## Decisions

- **DC-only JPEG decoding.** About 150 lines, versus a full decoder or a
  BSD-licensed dependency. The hard gate only allows small MIT
  dependencies.
- **Thresholds.** They are deliberately loose: they catch broken frames, not
  taste. Contrast and dark/bright are warnings.
- **Unsupported formats warn and skip.** They never error.

## Testing

- JPEG decoding: small fixtures in `tests/fixtures/present/`, made once with
  headless Blender (libjpeg, baseline). There are three: flat grey; a
  horizontal gradient at 4:2:0; and a two-colour split. Each fixture's DC
  decode must match its known size, mean and standard deviation.
- PNG and the rules: PNGs built in-test with `node:zlib` (one per colour type
  and filter).
- Live smoke: run lint over real `present render` captures from an existing
  project. They are not committed.
