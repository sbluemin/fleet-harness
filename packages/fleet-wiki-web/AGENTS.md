# fleet-wiki-web Doctrine

`packages/fleet-wiki-web` is a standalone web surface for Fleet Wiki workspaces.

## Owns

- The `fleet-wiki` CLI entry point.
- The detached local HTTP server for Fleet Wiki browsing.
- Web API routing, backlink indexing, PID/port lock handling, browser launch helpers, and the standalone Vite client SPA.
- The full visual identity of the Fleet Wiki reading experience — typography, color, spatial composition, motion, and atmosphere.

## Must Not Own

- Changes to `packages/fleet-wiki` exports, signatures, schemas, tools, or storage rules.
- Imports from `@sbluemin/fleet-core`, `@mariozechner/pi-*`, or `@anthropic-ai/*`.
- Pi runtime wiring, `ExtensionContext`, `registerCommand`, `registerTool`, or host UI registration.

## Dependency Rules

- Runtime dependencies should remain limited to `@sbluemin/fleet-wiki`, `marked`, `highlight.js`, and `dompurify`.
- HTTP serving must use Node.js built-in modules.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.
- Markdown parsing must reuse `@sbluemin/fleet-wiki` public behavior where available; package-local parsing is allowed only for web-only backlink support.
- Client code must stay Vanilla TypeScript. Do not add React, Preact, Svelte, Solid, router libraries, or state libraries.
- Client routing is owned by `client/src/router.ts` and must use the History API.
- Web fonts must be self-hosted via `@fontsource-variable/*` packages. External font CDNs (Google Fonts CDN, jsDelivr fonts, Adobe Fonts, etc.) are forbidden — every asset that ships to the browser must originate from a workspace dependency and end up in `dist/client/assets/`.

## Build Output

- `dist/cli.mjs` is the package binary.
- `dist/server.mjs` is the detached server entry.
- `dist/client/` is produced by Vite and contains `index.html`, bundled `assets/*.js`, `assets/*.css`, and font `assets/*.woff2` shards.

## Client Layout

- `client/src/main.ts` bootstraps the SPA.
- `client/src/api.ts`, `router.ts`, and `state.ts` own fetch, routing, and shared state.
- `client/src/components/` contains DOM/string render helpers for navigation, markdown, backlinks, command palette, metadata chips, ToC, related entries, the Manifest (raw source) card, and the Raw Source viewer (`raw-view.ts`).
- `client/src/raw-state.ts` owns the Raw Source viewer's standalone store (separate from the main `state.ts`) so that switching between a wiki entry and a raw view does not clobber the entry's loaded body or backlinks.
- `client/src/markdown/renderer.ts` owns marked + highlight.js integration.
- `client/src/styles/` is split into three layers and must remain so:
  - `theme.css` — tokens only (CSS variables, font imports, base reset, keyframes, scrollbar). No layout or component rules here.
  - `layout.css` — `app-shell` grid, sticky rails, breakpoints, off-canvas behavior, and staggered reveal animation hooks.
  - `components.css` — every concrete surface (sidebar, document, code-block, command palette, chips, toast, etc.). This is the file that owns the visual identity at the component level.

## Design Philosophy — "Maritime Codex"

Fleet Wiki's web surface is a **reading instrument**, not a generic docs template. Its visual language reinterprets the project's naval metaphor through a **modern maritime cartography lens** (deep-water ink, brass instrumentation, aurora signals) — never as retro-terminal pastiche or 90s-wiki nostalgia. Information is treated like a constellation: nodes, links, and back-references are foregrounded so the Admiral can navigate by sight.

The aesthetic intent is fixed and load-bearing — design changes that drift away from this identity are reviewed with the same rigor as code regressions.

### Identity Pillars

- **Atmospheric, not flat.** A document is presented over a layered field (multi-radial gradient + grain noise), never on a solid backdrop. Surfaces float on this field via glassmorphism; they do not sit on a void.
- **Typeset, not formatted.** Headings use a variable serif (`Fraunces`) at large optical sizes; body uses a humanist grotesque (`Manrope`); code uses a contemporary mono (`JetBrains Mono`). The package is allowed to look like editorial product, not like a terminal log.
- **Brass-led, aurora-supported.** Brass is the primary accent (active states, structural rules, code-block dots middle, hover gain); aurora cyan is the secondary accent reserved for **document-to-document linkage** (links in body copy, backlink panel hover, link emphasis). This separation is intentional — it tells the eye when it is moving *within* a document vs *between* documents.
- **Motion as orchestration.** A page paint produces one staggered reveal (`codex-rise` 720ms with 40/120/200ms delays across the three rails). Hover and focus states are restrained to 1–2px lift, brass-dot indicators that slide into place, and spring-eased fades. No micro-bouncing, no parallax, no infinite ambient motion.
- **Distinct, not generic.** The surface should not converge on Linear/Vercel/Notion clones. Originality lives in the Fraunces italic display, the brass+aurora pairing, and the constellation framing of backlinks.

## Typography Doctrine

| Role | Family | Source | Notes |
|------|--------|--------|-------|
| Display | `Fraunces Variable` | `@fontsource-variable/fraunces` | Welcome title, document `h1`, `h2` (large optical size), related-card titles. Italic + `opsz: 144` + `SOFT: 100` reserved for the Welcome hero. |
| Body | `Manrope Variable` | `@fontsource-variable/manrope` | Default UI and body copy. Letter-spacing is consistently slightly tightened (`-0.005em` to `-0.01em`). |
| Mono | `JetBrains Mono Variable` | `@fontsource-variable/jetbrains-mono` | Code blocks, inline code, `kbd`, chips, eyebrow labels (uppercase + tracked). |

### Font Hard Bans

The following fonts must not appear in CSS, even as fallbacks before the variable family:

- `Inter`, `Roboto`, `Arial`, `Helvetica`, `system-ui` *as a primary family*. (They may appear deep in a fallback stack only after the brand family.)
- Any `@import url("https://fonts.googleapis.com/...")` or other CDN-hosted webfont reference.
- Any `<link rel="stylesheet" href="https://...">` in `client/index.html`.

Reviewer rule: if a CSS file declares a `font-family` whose first entry is generic or system, treat it as a regression.

## Color System

The palette is defined in `theme.css` using `oklch()` to keep perceptual uniformity across hues. Components must reference these tokens — raw hex values inside `components.css` are a regression.

| Token | Role |
|-------|------|
| `--ink-abyss` / `--ink-deep` / `--ink-mid` / `--ink-veil` / `--ink-rim` | Background and surface tints, deep-ocean → mid-water gradient |
| `--ink-fog` / `--ink-spectral` / `--ink-pearl` | Text scale (secondary → muted → primary, warm-tinted) |
| `--brass` / `--brass-bright` / `--brass-deep` / `--brass-glow` | Primary accent — active nav, structural rules, focus, code dots middle |
| `--aurora` / `--aurora-deep` / `--aurora-glow` | Secondary accent — **document linkage only** (markdown body links, backlink hover, occurrences chip) |
| `--coral` / `--coral-glow` | Danger / error |
| `--surface-glass*` / `--surface-pillar` / `--surface-rim*` | Translucent surface fills used with `backdrop-filter` |
| `--shadow-soft` / `--shadow-floating` / `--shadow-anchor` | Three shadow tiers; cards use `--shadow-soft`, modals/toasts use `--shadow-floating`, accent-bound interactives use `--shadow-anchor`. |

### Color Hard Bans

- Solid `#ffffff` or `#000000` as a background is forbidden.
- The purple-gradient-on-white cliché is forbidden.
- Aurora must not be used for primary or active states (those are brass) — keeping the brass/aurora division intact is a doctrine invariant, not a styling preference.

## Surface, Atmosphere, Radius

- The viewport background is owned exclusively by `body::before` (multi-radial gradient mesh) and `body::after` (inline SVG `feTurbulence` grain at ~45% opacity, `mix-blend-mode: overlay`). Components must not redefine `body` background or replace these layers.
- Cards and rails use `backdrop-filter: blur(18px) saturate(140%)` over `--surface-glass`. The command palette uses `blur(24px) saturate(150%)` over `--surface-pillar` — that is the only surface allowed a stronger blur.
- Radius scale: `--radius-xs: 8px` (chips/buttons inner), `--radius-sm: 10px` (small chrome), `--radius-md: 14px` (interactive blocks), `--radius-lg: 18px` (palette card), `--radius-xl: 24px` (document/sidebar/right-rail). Sharp corners (≤ 4px) are forbidden anywhere except hairline elements (e.g., 1px gradient rules) — this is the explicit cure for the previous "retro" perception.

## Spatial Composition

- Desktop grid: `288px | minmax(0, 760px) | 332px`, gap `32px`, top-aligned, centered.
- Tablet (≤ 1280px): collapses to `264px | 1fr`, with the right rail moving below the document.
- Mobile (≤ 960px): the sidebar becomes an off-canvas drawer; a fixed glass hamburger button appears at the top-left.
- Sticky rails (`.sidebar`, `.backlinks-panel`, `.toc-panel`) are required at desktop; this is what produces the "constellation while you read" effect.
- Document max-width and grid offsets must remain stable; `client/src/styles/layout.css` is the single owner of these numbers.

## Motion Doctrine

- Easing: `--ease-spring` for arrivals/active states; `--ease-glide` for hover/secondary transitions; durations come from `--duration-fast`/`base`/`slow` (140 / 220 / 360ms).
- Page-level reveal: `codex-rise` is dispatched once on initial paint, staggered 40 / 120 / 200ms across the three rails. Re-running it on every state update is a regression.
- Active states should always communicate position with a brass dot indicator that slides into place (see `.nav-entry.active::before` and `.command-result.active::before`) rather than a heavy fill.
- `prefers-reduced-motion: reduce` must continue to short-circuit all animations to ~0.01ms (already enforced in `theme.css`); contributors must test changes under this media query before merging significant motion edits.

## Component Identity Anchors

Specific, non-negotiable details that define the surface — change them only with intent:

- **Brand mark.** Inline SVG compass-rose in the sidebar header, brass-tinted, framed in a small glass tile with `--shadow-anchor`. Replacing it with an emoji or a generic logo is a regression.
- **Top rim of `.document`.** A 1px linear-gradient hairline (transparent → brass → aurora → transparent) sits at `top: 0`. This rim is the principal visual signature of an open document and must be preserved.
- **Document `h2`.** A 3px brass vertical glow rule on the left, with `--brass-glow` shadow — this is what makes long-form reading feel typeset.
- **Code block.** A toolbar of three macOS-style colored dots, a centered uppercase language label, and a brass-on-hover "복사" button. The body of the block has no inner border on the code element itself.
- **Backlinks panel.** Header is a brass tracked-uppercase eyebrow ("Constellation") plus a Fraunces subtitle ("이 문서를 참조하는 항목"). Hover state slides the entry 3px right and tints with aurora. The "constellation" framing is intentional, not a label choice.
- **Manifest card.** Surfaces the current entry's `frontmatter.rawSourceRef` as a brass-led "이 문서가 적재된 원본" link. The link points to the SPA route `/raw/{encoded ref}` (not directly to `/api/raw`); clicking it transitions the SPA into the **Raw Source viewer** described below — same tab, History API, sanitized markdown rendering. Header is the brass tracked-uppercase eyebrow "Manifest" plus a Fraunces subtitle "원본 출처", flanked by a small brass-tinted scroll glyph. Brass (rather than aurora) is used because Manifest points outward to a non-document asset on disk — Constellation/Related remain the document-to-document accents. The card is rendered only when `rawSourceRef` is present; absence must keep the rail clean (no empty placeholder).
- **Raw Source viewer (`/raw/:ref`).** A **layout-less, single-page** SPA route that reuses the package's atmospheric body, fonts, and `marked + DOMPurify + highlight.js` markdown pipeline, but **deliberately omits** the sidebar, command palette tab UI, ToC, related list, backlinks, and rail. The viewer is a centered max-width column (920px) holding (1) a "← Codex" pill that History-API-navigates back to home, (2) a small brass scroll glyph + tracked-uppercase eyebrow "Manifest · Raw Source" + the ref path in JetBrains Mono, (3) a brass→aurora gradient divider, and (4) a single glass document card with the rendered markdown. This is intentionally a *reader*, not a workspace — adding sidebar/rail UI to this route is a regression. Owned by `client/src/components/raw-view.ts` and `client/src/raw-state.ts`.
- **Command palette.** Spring-pop entrance via `codex-pop`, glass card with stronger blur, search-icon prefix, `esc` kbd suffix, brass-dot active indicator on the result list.

## Hard Bans Summary (Review Gate)

A change in `client/` should be flagged by reviewers if it does any of the following:

1. Reintroduces `Inter`, `Roboto`, `Arial`, or `system-ui` as a primary `font-family`.
2. Loads a font from an external CDN.
3. Uses solid `#fff` / `#000` as a background.
4. Sets `border-radius` ≤ 4px on a card, panel, button, or chip.
5. Replaces the layered body background with a flat fill.
6. Uses aurora for an active/primary state, or brass for a body-copy link inside markdown.
7. Removes or replaces the brand compass-rose, the document top-rim hairline, the brass `h2` rule, or the code-block macOS dots toolbar without replacing them with an equally distinctive equivalent.
8. Disables or removes the `prefers-reduced-motion` short-circuit.

Items 1–8 are doctrine; reviewers should request a fix or an explicit doctrine update in this file before approval.

## Security Boundaries

The web surface is a defense-in-depth layer over the `fleet-wiki` leaf package. Because `fleet-wiki` doctrine forbids modifying its read path, every server-side guard lives here:

- **Path traversal defense.** `src/routes.ts` validates entry IDs with `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and rejects encoded slashes before any fleet-wiki call. The same file's `resolveSafeRawPath()` enforces that `/api/raw?ref=...` payloads start with `raw/`, contain no traversal segments, and resolve to an absolute path that is contained inside `paths.rawDir`; fleet-wiki cannot expose `assertSafeRawSourceRef` due to leaf doctrine, so this contained-by-`raw/` check is the package's own first-line defense. Tests under `tests/security-routes.test.ts`.
- **Markdown XSS defense.** `client/src/markdown/renderer.ts` runs every `marked` output through DOMPurify with a `javascript:`/`data:` scheme block and only then injects via `innerHTML`. Tests under `tests/security-markdown.test.ts`.
- **Method whitelist.** Top-level request handler accepts only `GET` and `HEAD`; everything else returns `405` with `Allow: GET, HEAD`. Malformed URLs return `400` instead of throwing an unhandled rejection.
- **Lockfile.** Per-user lock directory at `0700`, lockfile at `0600` opened with `wx`, symlinks rejected via `lstat`. `src/lock.ts` and `tests/security-lock.test.ts`.
- **CORS / binding.** Server binds to `127.0.0.1` only and never sets `Access-Control-Allow-Origin: *`. Adding either is a regression.
- **SPA fallback.** Static-file misses fall back to `client/index.html` only when (a) the path does not start with `/api/` or `/assets/` and (b) the path has no file extension. This is the discipline that lets `/entry/:id` and `/raw/:ref` survive a hard refresh or new-tab open without breaking the API/asset 404 contracts.

Do not relax any of these guards in the name of design or developer convenience.

## Change Control

Edits to design tokens (`theme.css`), spatial scale (`layout.css`), or component identity anchors (`components.css` + the corresponding component renderers) must be accompanied by an update to the relevant section of this file in the same commit. Tokens and doctrine drift in lockstep — that is the only way the visual identity stays stable across future contributions.
