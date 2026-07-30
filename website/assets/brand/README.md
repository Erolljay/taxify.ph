# Txform.ph brand assets

Drop your original logo files into **this folder** (`website/assets/brand/`).
These are your actual created files — do not regenerate them.

Preferred: **.svg** (scales perfectly at any size). If you only have PNG, that's fine too —
send the largest/highest-resolution version you have.

## Files to add (use these exact names if you can)

| File name | What it is | Used for |
|-----------|-----------|----------|
| `txform-mark.svg`          | The `><` chevron mark alone (navy `>` + green `<`) | favicon, app icon, small spots |
| `txform-logo-horizontal.svg` | Horizontal wordmark: mark + **Txform.ph** in a row | site header, footer |
| `txform-logo-stacked.svg`  | Mark above **Txform.ph** (the PRIMARY lockup) | large/hero, social, share image |
| `favicon.ico`              | Multi-size .ico (16/32/48) if you have one | browser tab (fallback) |

If your file names are different, no problem — just drop them in and I'll rename them.

## Colours (for reference)
- Navy: `#0B2447`
- Green: `#19A974`

## Received files (2026-07-30) — actual user-created assets, do NOT recreate

| File (as delivered) | Size | Role |
|---------------------|------|------|
| `Txform.ph_favicon.png`   | 100×100  | favicon (the `><` mark) |
| `Txform.ph_icon..png`     | 1000×756 | `><` mark, large — app-icon / favicon source |
| `Txform.ph_primary.png`   | 1000×284 | **horizontal Txform.ph wordmark → site header + footer** |
| `Txform.ph_secondary.png` | 1000×756 | stacked mark + wordmark → social / OG share image |

All PNG (no SVG provided). PNG is fine; if a source SVG turns up later, swap it in for crisper scaling.

## Build steps (Step A, when go-ahead is given)
1. Header + footer across every page → `Txform.ph_primary.png` (horizontal wordmark).
2. `favicon.ico` + `apple-touch-icon.png` generated from `Txform.ph_icon..png` (down-scaled 180/32/16).
3. Open Graph / Twitter share image → `Txform.ph_secondary.png`.
4. Portal (`account.html`) header → same horizontal wordmark; align its green to `#19A974`.
