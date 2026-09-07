# Density measurements — feat/mobile-density

Produced by `node e2e/measure-density.js --label <label>` (metrics defined in `e2e/density-metrics.js`). Chrome = viewport − card content box (at 1280 this includes the shell's centering margins — the 1080px `--shell-max` cap, deliberate whitespace, not chrome in the 375px sense).

## before — 2026-08-02T01:34:52.089Z (page: /digests/2026-01-03)

| viewport | prose px | chrome px | chrome % | font px | line-height px | avg glyph px | cpl | h-overflow |
|---|---|---|---|---|---|---|---|---|
| 375 | 291 | 84 | 22.4% | 17 | 28.1 | 7.95 | 36.6 | YES |
| 768 | 652 | 116 | 15.1% | 17 | 28.1 | 7.95 | 82 | no |
| 1280 | 734 | 316 | 24.7% | 17 | 28.1 | 7.95 | 92.3 | no |

## after — 2026-08-02T01:36:41.135Z (page: /digests/2026-01-03)

| viewport | prose px | chrome px | chrome % | font px | line-height px | avg glyph px | cpl | h-overflow |
|---|---|---|---|---|---|---|---|---|
| 375 | 331 | 44 | 11.7% | 15 | 23.3 | 7.02 | 47.2 | no |
| 768 | 551 | 84 | 10.9% | 17 | 27.2 | 7.95 | 69.3 | no |
| 1280 | 551 | 316 | 24.7% | 17 | 27.2 | 7.95 | 69.3 | no |

## after-desktop-column — 2026-08-02T02:50:54.467Z (page: /digests/2026-01-03)

| viewport | prose px | chrome px | chrome % | font px | line-height px | avg glyph px | cpl | h-overflow |
|---|---|---|---|---|---|---|---|---|
| 375 | 331 | 44 | 11.7% | 15 | 23.3 | 7.02 | 47.2 | no |
| 768 | 551 | 217 | 28.3% | 17 | 25.5 | 7.95 | 69.3 | no |
| 1280 | 551 | 729 | 57% | 17 | 25.5 | 7.95 | 69.3 | no |

The desktop reading column (`fix/desktop-reading-column`): 375 is byte-identical
to the mobile pass (phone untouched); 768/1280 keep 69.3 cpl while the card
narrows to hug the prose (card content box = the 551px measure — the shared
edge, guarded by TP-nexus-e2e-062), so from here on "chrome" at 768/1280 is the
COLUMN's centering margins, deliberate whitespace, comparable across runs but
not to the 375px sense. Line-height 27.2→25.5 is `--lh-reading` 1.6→1.5.

## after-full-width — 2026-08-02T03:13:51.663Z (page: /digests/2026-01-03)

| viewport | prose px | chrome px | chrome % | font px | line-height px | avg glyph px | cpl | h-overflow |
|---|---|---|---|---|---|---|---|---|
| 375 | 331 | 44 | 11.7% | 15 | 23.3 | 7.02 | 47.2 | no |
| 768 | 684 | 84 | 10.9% | 17 | 25.5 | 7.95 | 86 | no |
| 1280 | 964 | 316 | 24.7% | 17 | 25.5 | 7.95 | 121.2 | no |

