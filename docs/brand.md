# CloakCal brand assets

What the references actually specify, what was extrapolated, and how to regenerate any of it.

Same discipline as [screen-inventory.md](screen-inventory.md): recording which is which stops a
later "this doesn't match the brand" argument that neither side can settle.

## The references

| File | What it is |
|---|---|
| `Brand Info Concepts 2.png` | Visual Guide **Page 1 of 8** — palette, type, do/don't, core metaphor. Authoritative. |
| `Brand Info Concepts.png` | Brand board — logo variations, app icon concepts, two rendered screens. |

**Pages 2–8 have never been supplied.** They are the likely home of clearspace rules, minimum
sizes and the icon grid, so those are extrapolated below. The second board also misprints two
hex values (`#GD5CFF`, `#0BOD14` with a letter O), which is why Page 1 wins on conflict.

## The mark

One geometry, in [`cloak-mark.ts`](../apps/web/src/components/cloak-mark.ts). Everything else
consumes it: the React lockup, the favicon, the ICO, the tiles and the social card.

### Derived from the references

- A rounded calendar tile with two tabs on top and a grid of date dots.
- A cloak sweeping across the lower-right corner.
- Indigo `#6D5CFF` → violet `#7C3AED` gradient on the tile face.
- The wordmark: "Cloak" in white, "Cal" in the accent, Inter Semibold.
- Tagline "YOUR TIME. YOUR BUSINESS." in letterspaced caps.

### Extrapolated, and why

**Flat, not shaded.** The board renders the mark with soft 3D shading and a photoreal cloth
edge. That turns to mud below about 32px, and the guide's own DON'T list says avoid harsh
shadows and keep it clean. The three ideas are drawn flat instead.

**The dots under the cloak are absent, not dimmed.** Six of nine dates visible, three not.
This is a deliberate improvement on the reference: it draws the product rather than
decorating it, and it is what survives being 16 pixels wide.

**The cloak is slate → charcoal (`#2E3350` → `#151824`), not the deep navy the board shows.**
Deep navy `#0B0D14` *is* the page background, so a navy cloak on a navy page read as a bite
taken out of the tile rather than fabric laid over it. Caught by rendering it and looking,
which is the only way that kind of thing is ever caught.

**A separate 16px drawing.** Nine dots merge into a grey smear at favicon size and the tabs
become two stray pixels, so the `favicon` variant drops the tabs and carries three larger
dots. Same silhouette, same cloak, legible at the size a browser tab actually rasterises.

**Clearspace and minimum size are not specified anywhere.** Working rule until pages 2–8
arrive: clear space equal to the tab height on all sides; never below 16px.

**No standalone mono variant.** The board names MONO LIGHT and MONO DARK. Nothing in the
product needs one — the only single-colour usage is the white knockout on the app tile, which
is the `tile` variant. Add mono when something actually needs it.

## Colour, and the one deliberate divergence

The mark uses brand indigo and violet directly. Those are graphic fills; no text sits on them.

`--accent` is a **different, darker** value (`#6152E6` dark, `#5847E0` light) and must stay
that way. White text on `#6D5CFF` is 4.20:1 and fails WCAG AA — it shipped that way on the
Save button and the New event control before it was caught. See the comment at
[tokens.css:136](../packages/ui/src/tokens.css#L136). **Do not "fix" the tokens to match the
board.**

## Typography

Inter, per the guide, **self-hosted**:

| | |
|---|---|
| Version | v4.1 (`Version 4.001`), pinned to the git tag, not a branch |
| File | `apps/web/src/app/fonts/InterVariable.woff2` |
| Size | 352,240 bytes |
| sha256 | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| Axes | `wght 100–900`, `opsz 14–32` |
| Licence | SIL OFL 1.1, `OFL.txt` beside the font. No UI attribution required. |

Source: `https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2`

Self-hosted rather than `next/font/google` so the build never depends on a network fetch —
the Playwright suite starts its own dev server, and a font timeout would surface as a flaky
test rather than as a network problem.

**Inter was named in the tokens from M0 and never actually loaded.** Every screen rendered in
the platform UI font until this landed, which is invisible on a Mac because the fallback is
San Francisco and it looks fine.

`--font-sans` resolves `var(--font-inter, 'Inter')` so `packages/ui` stays free of any Next
dependency, and the generated class goes on `<html>` — see the comment in `layout.tsx` for why
that placement is load-bearing rather than stylistic.

## Regenerating the assets

```bash
pnpm brand:assets
```

Rasterises everything from `cloak-mark.ts` using the Playwright Chromium already installed.
Output is **committed** — this is not a build step, and neither CI nor Vercel runs it. Run it
only when the mark changes, and commit the result.

| File | Purpose |
|---|---|
| `apps/web/src/app/icon.svg` | Primary favicon |
| `apps/web/src/app/favicon.ico` | 16/32/48. Safari only got SVG favicons in 26.0 |
| `apps/web/src/app/apple-icon.png` | 180×180, opaque and full-bleed; iOS adds its own radius |
| `apps/web/src/app/opengraph-image.png` | 1200×630 social card |
| `apps/web/public/icons/icon-{192,512}.png` | PWA install, `purpose: any` |
| `apps/web/public/icons/icon-512-maskable.png` | Android adaptive, mark inside the 80% safe circle |

## Two traps these assets sit on

**Static, not generated, because of the middleware.** A `next/og` route serves at a path with
no file extension (`/opengraph-image`), and the middleware matcher excludes static assets *by
extension* — so the social card would 307 to `/sign-in` for anyone not logged in, which is
every crawler and every link-unfurl bot. It would also be invisible locally: dev and Playwright
both run with `NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1`, which returns early before any redirect.
`middleware-paths.server.test.ts` pins every asset path.

**Never declare `metadata.icons`.** Next merges the `app/icon.*` and `app/apple-icon.*` file
conventions only when that key is undefined. Setting it — even partially, even in one page —
silently deletes every tag those files would have emitted. `favicon.ico` is special-cased and
survives, which makes the breakage look partial and random rather than total.
