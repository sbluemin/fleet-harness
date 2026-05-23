# fleet-wiki-web Doctrine

`packages/fleet-wiki-web` is a standalone web surface for Fleet Wiki workspaces. It runs one per-user daemon that can serve multiple registered workspaces concurrently.

## Owns

- The `fleet-wiki` CLI entry point. 글로벌 `fleet-wiki` CLI 진입점은 `process.cwd()`에서 부모 방향으로 가장 가까운 `packages/fleet-wiki-web/dist/cli.mjs`를 탐색해 자기 자신과 다르면 그 경로로 재spawn(`spawnSync`, `stdio: inherit`)한다. 이를 통해 git worktree 안에서도 worktree-local dist가 자동 사용된다. 무한 재spawn은 경로 비교 + `FLEET_WIKI_TRAMPOLINED=1` 보조 가드로 방지.
- The detached per-user local HTTP daemon for Fleet Wiki browsing.
- Web API routing, daemon PID/port lock handling, in-memory workspace registration, browser launch helpers, and the standalone Vite client SPA.
- The full visual identity of the Fleet Wiki reading experience — typography, color, spatial composition, motion, and atmosphere.

## Must Not Own

- Changes to `packages/fleet-wiki` exports, signatures, schemas, tools, or storage rules.
- Imports from `@mariozechner/pi-*` or `@anthropic-ai/*`.
- Pi runtime wiring, `ExtensionContext`, `registerCommand`, `registerTool`, or host UI registration.

## Dependency Rules

- Runtime dependencies should remain limited to `@sbluemin/fleet-wiki`, `marked`, `highlight.js`, `dompurify`, and `mermaid`. `mermaid` is loaded only via dynamic `import("mermaid")` inside `client/src/markdown/diagrams.ts`; no other module may statically import it.
- HTTP serving must use Node.js built-in modules.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.
- Markdown parsing must reuse `@sbluemin/fleet-wiki` public behavior where available; package-local parsing is forbidden.
- Client code must stay Vanilla TypeScript. Do not add React, Preact, Svelte, Solid, router libraries, or state libraries.
- Client routing is owned by `client/src/router.ts` and must use the History API.
- Web fonts must be self-hosted via `@fontsource-variable/*` packages. External font CDNs (Google Fonts CDN, jsDelivr fonts, Adobe Fonts, etc.) are forbidden — every asset that ships to the browser must originate from a workspace dependency and end up in `dist/client/assets/`.

## Link Syntax Standard

- Canonical wiki link syntax is `[[wiki:id]]` (cross-layer standard defined in `@sbluemin/fleet-wiki/src/links.ts`).
- Web renderer in `client/src/markdown/renderer.ts` converts `[[wiki:foo]]` to the current workspace's `/w/:ws/entry/foo` SPA links with `data-entry-id` attributes. The pattern is **inlined** with an SSoT comment — the client must never `import` from `@sbluemin/fleet-wiki` because that package's Node-only modules (`fs`/`path`/`crypto`) would break the Vite browser bundle.
- Legacy markdown links `[title](entry.md)` remain readable but trigger `legacy_markdown_wiki_link` warning in `wiki_drydock`.

## SPA Routes

- `/` — Welcome / index landing, including the expired-workspace notice when a stale workspace URL redirects home.
- `/w/:ws/` — Canonical workspace Welcome / index landing.
- `/w/:ws/entry/:id` — Entry markdown view with related/manifest panels and copy-context actions.
- `/w/:ws/raw/:ref` — Raw source viewer (untrusted boundary indicator).
- `/w/:ws/queue` — Drydock pending list. `/w/:ws/queue/:patchId` — patch detail with patch-set membership and approve/reject.
- `/w/:ws/conflicts` — Conflict list (read from the selected workspace's `.fleet/knowledge/conflicts/`). `/w/:ws/conflicts/:id` — conflict detail showing `current.md` vs `proposed.md` plus raw source.
- `/w/:ws/index-md` — `wiki/index.md` rendered as a deterministic catalog.
- `/w/:ws/log?limit=N` — Tail of `log.md` ingest/patch/drydock/rebuild events.
- Legacy routes (`/entry/:id`, `/raw/:ref`, `/queue`, `/conflicts`, `/index-md`, `/log`) redirect to the MRU workspace when one exists. If no MRU exists, navigations redirect to `/` and JSON/XHR clients receive `404 no_workspace_registered`.
- Canonical API routes live under `/w/:ws/api/...`; legacy `/api/...` resolves through MRU when registered.

## Copy-Context Actions

`client/src/components/copy-context-actions.ts` exposes three clipboard actions plus one disclosure toggle inside the entry Manifest card:
- **Compact context** — entry frontmatter + body summary as compact JSON.
- **With provenance** — adds `rawSourceRefs[]` blocks.
- **Related context pack** — calls `wiki_resolve` (markdown_pack format) and copies the result.
- **Why this matched** — toggles the current briefing-match rationale inline when present.

## Status Badges

`markdown-view.ts` renders a status badge (current / deprecated / superseded) and a stale badge (when `revalidateAfter` has passed) on the entry header. Colors honor the Maritime Codex palette (brass for current, amber for stale, coral for deprecated/superseded).

## Security Headers

Server response (static + API) attaches:
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`

POST Origin guard for browser-facing queue mutations, lockfile bearer auth for CLI-only `POST /api/admin/workspaces`, DOMPurify XSS sanitization (`javascript:`/`data:` blocked), `O_EXCL` lockfile creation, and path-traversal containment all remain unchanged.

## Build Output

- `dist/cli.mjs` is the package binary and the worktree-aware trampoline entry point.
- `dist/server.mjs` is the detached server entry.
- `dist/client/` is produced by Vite and contains `index.html`, bundled `assets/*.js`, `assets/*.css`, and font `assets/*.woff2` shards.

## Client Layout

- `client/src/main.ts` bootstraps the SPA.
- `client/src/api.ts`, `router.ts`, and `state.ts` own fetch, routing, and shared state.
- `client/src/queue-state.ts` owns the Drydock (queue/archive) viewer's standalone store — separate from `state.ts` so switching between entries and queue views does not clobber the entry's loaded body.
- `client/src/components/` contains DOM/string render helpers for navigation, markdown, command palette, metadata chips, ToC, related entries, the Manifest (raw source) card, the Raw Source viewer (`raw-view.ts`), the Drydock list (`queue-list.ts`), the Drydock detail (`queue-detail.ts`), and the op-badge (`op-badge.ts`).
- `client/src/raw-state.ts` owns the Raw Source viewer's standalone store (separate from the main `state.ts`) so that switching between a wiki entry and a raw view does not clobber the entry's loaded body.
- `client/src/markdown/renderer.ts` owns marked + highlight.js integration.
- `client/src/styles/` is split into three layers and must remain so:
  - `theme.css` — tokens only (CSS variables, font imports, base reset, keyframes, scrollbar). No layout or component rules here.
  - `layout.css` — `app-shell` grid, sticky rails, breakpoints, off-canvas behavior, and staggered reveal animation hooks.
  - `components.css` — every concrete surface (sidebar, document, code-block, command palette, chips, toast, etc.). This is the file that owns the visual identity at the component level.

## Design Philosophy — "Maritime Codex"

Fleet Wiki's web surface is a **reading instrument**, not a generic docs template. Its visual language reinterprets the project's conceptual **naval metaphor** through a **modern maritime cartography lens** (deep-water ink, brass instrumentation, aurora signals) — never as retro-terminal pastiche or 90s-wiki nostalgia. Information is treated like a constellation: nodes, links, and back-references are foregrounded so the Admiral can navigate by sight.

The aesthetic intent is fixed and load-bearing — design changes that drift away from this identity are reviewed with the same rigor as code regressions.

### Identity Pillars

- **Atmospheric, not flat.** A document is presented over a layered field (multi-radial gradient + grain noise), never on a solid backdrop. Surfaces float on this field via glassmorphism; they do not sit on a void.
- **Typeset, not formatted.** Headings use a variable serif (`Fraunces`) at large optical sizes; body uses a humanist grotesque (`Manrope`); code uses a contemporary mono (`JetBrains Mono`). The package is allowed to look like editorial product, not like a terminal log.
- **Brass-led, aurora-supported.** Brass is the primary accent (active states, structural rules, code-block dots middle, hover gain); aurora cyan is the secondary accent reserved for **document-to-document linkage** (links in body copy, backlink panel hover, link emphasis). This separation is intentional — it tells the eye when it is moving *within* a document vs *between* documents.
- **Motion as orchestration.** A page paint produces one staggered reveal (`codex-rise` 720ms with 40/120/200ms delays across the three rails). Hover and focus states are restrained to 1–2px lift, brass-dot indicators that slide into place, and spring-eased fades. No micro-bouncing, no parallax, no infinite ambient motion.
- **Distinct, not generic.** The surface should not converge on Linear/Vercel/Notion clones. Originality lives in the Fraunces italic display and the brass+aurora pairing.

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
| `--aurora` / `--aurora-deep` / `--aurora-glow` | Secondary accent — **document linkage only** (markdown body links, occurrences chip) |
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

- Desktop grid: `256px | minmax(0, 1fr) | 272px`, gap `24px`, top-aligned, centered.
- Tablet (≤ 1280px): collapses to `264px | 1fr`, with the right rail moving below the document.
- Mobile (≤ 960px): the sidebar becomes an off-canvas drawer; a fixed glass hamburger button appears at the top-left.
- Drydock routes (`/queue`, `/queue/:patchId`) add `.app-shell--wide` modifier, collapsing the desktop grid to `256px | 1fr` with the global right rail hidden; the Drydock detail view has its own inline rail via `.queue-detail-layout`.
- Sticky rails (`.sidebar`, `.toc-panel`) are required at desktop. `.toc-panel` is a child of the right `.rail`.
- Document max-width and grid offsets must remain stable; `client/src/styles/layout.css` is the single owner of these numbers.

## Motion Doctrine

- Easing: `--ease-spring` for arrivals/active states; `--ease-glide` for hover/secondary transitions; durations come from `--duration-fast`/`base`/`slow` (140 / 220 / 360ms).
- Page-level reveal: `codex-rise` is dispatched once on initial paint, staggered 40 / 120 / 200ms across the three rails. Re-running it on every state update is a regression.
- Active states should always communicate position with a brass dot indicator that slides into place (see `.nav-entry.active::before` and `.command-result.active::before`) rather than a heavy fill.
- `prefers-reduced-motion: reduce` must continue to short-circuit all animations to ~0.01ms (already enforced in `theme.css`); contributors must test changes under this media query before merging significant motion edits.

## Component Identity Anchors

Specific, non-negotiable details that define the surface — change them only with intent:

- **Brand mark.** Inline SVG compass-rose in the sidebar header, brass-tinted, framed in a small glass tile with `--shadow-anchor`. Replacing it with an emoji or a generic logo is a regression.
- **Top rim of `.document`.** A 1px linear-gradient hairline (transparent → brass → aurora → transparent) sits at `top: 0`. This rim is the principal visual signature of an open document and must be preserved. The Drydock detail view reuses this same `.document` glass card for wikiEntry body rendering — do not add a separate hairline there.
- **Document `h2`.** A 3px brass vertical glow rule on the left, with `--brass-glow` shadow — this is what makes long-form reading feel typeset.
- **Code block.** A toolbar of three macOS-style colored dots, a centered uppercase language label, and a brass-on-hover "복사" button. The body of the block has no inner border on the code element itself.
- **Diagram block (`.diagram-block`).** Mermaid fences (```` ```mermaid ````) emit an inert placeholder rendered into a glass surface that is **visually distinct from `.code-block`**. The block carries a JetBrains Mono uppercase tracked eyebrow `MANIFEST · DIAGRAM`, a brass-led node/border treatment, and a 1px top hairline matching `.document`. Wide or tall diagrams use inline `overflow: auto` with brass scrollbar tokens; `.document { overflow: hidden }` remains intact, while `.diagram-block svg { max-width: none; width: max-content }` makes the SVG use its intrinsic width and lets the wrapper's `overflow: auto` own clipping and scrolling. The entire rendered diagram is a Tab-focusable click/Enter/Space target (`cursor: zoom-in`) that opens an accessible lightbox using a native `<dialog>` and an in-house pan/zoom controller (no external pan/zoom dep). The lightbox features interactive header zoom controls (25/50/75/100/125/150/200/300/400% steps), auto-fit on open keyed to inline size, drag-to-pan via native scrollbars, Ctrl/Cmd+wheel zoom around the cursor, keyboard shortcuts (+/-/0/f), and a double-click 200% ↔ 100% toggle. To ensure visual parity, the controller clones the SVG, strips fixed `max-width` styles, and retargets Mermaid's ID-based CSS namespacing. To preserve navigation for diagrams with embedded links, the click-to-expand behavior and associated `role="button"` are automatically disabled when an `<a>` tag is detected within the SVG (anchor-link guard). The hydrator (`client/src/markdown/diagrams.ts`) is the **only** place Mermaid runs, and it must use `securityLevel: "strict"`, `htmlLabels: false`, `look: "handDrawn"`, and never call `bindFunctions`. DOMPurify must sanitize the cloned SVG before injection into the dialog. Every interaction must respect `prefers-reduced-motion`.
- **ToC card (`.toc-panel`).** The second card in the right `.rail` (positioned below Manifest). It is a sticky glass card (`--surface-glass`, blur 18px, `--radius-xl`, `--shadow-soft`) featuring a brass tracked-uppercase eyebrow `CONTENTS` and the table of contents list. The card is rendered only on the entry route and must not be rendered if the ToC is empty (`items.length === 0`). On mobile (≤960px), it is hoisted above the document via `:has(.toc-panel)` logic.
- **Manifest card.** Surfaces the current entry's WikiEntry frontmatter as a `<dl>` with fields: 생성(created), 갱신(updated), 버전(version), 태그(tags), 원본(rawSourceRef). Header is the brass tracked-uppercase eyebrow "MANIFEST · CODEX" plus a Fraunces subtitle "문서 매니페스트". All fields are shown for any open entry — the card renders whenever an entry is loaded, not only when `rawSourceRef` is present. The rawSourceRef row, if present, links to the SPA route `/raw/{encoded ref}` (not directly to `/api/raw`) via the brass manifest-link style; when absent, the row shows "없음" in muted ink. The `queue-dl-*` CSS vocabulary is shared with the Patch Manifest rail. Reuses `formatAbsoluteDate` / `relativeTime` from `client/src/utils/time.ts`. Brass (rather than aurora) is used because Manifest points outward to a non-document asset on disk — Related entries remain the document-to-document accents. Owned by `client/src/components/manifest-panel.ts`.
- **Raw Source viewer (`/raw/:ref`).** A **layout-less, single-page** SPA route that reuses the package's atmospheric body, fonts, and `marked + DOMPurify + highlight.js` markdown pipeline, but **deliberately omits** the sidebar, command palette tab UI, ToC, related list, and rail. The viewer is a centered max-width column (920px) holding (1) a "← Codex" pill that History-API-navigates back to home, (2) a small brass scroll glyph + tracked-uppercase eyebrow "Manifest · Raw Source" + the ref path in JetBrains Mono, (3) a brass→aurora gradient divider, and (4) a single glass document card with the rendered markdown. This is intentionally a *reader*, not a workspace — adding sidebar/rail UI to this route is a regression. Owned by `client/src/components/raw-view.ts` and `client/src/raw-state.ts`.
- **Drydock list card (`/queue`).** Two-column glass card with patchId in JetBrains Mono + status dot at top, relative time + optional warning chips at bottom. Hover: 3px right translate + aurora rim border. The list is reached from the sidebar's Drydock nav entry, which sits **between the search `command-entry` and the `nav-tabs` (Entries|Tags)** — separated from both by `1px surface-rim` dividers. The entry shows a pending-count badge in brass.
- **Patch detail manifest rail (`/queue/:patchId`).** Right rail card with brass tracked-uppercase eyebrow "MANIFEST · PATCH" + Fraunces subtitle "패치 매니페스트". A `<dl>` lists op/target/proposer/createdAt/status/warnings. If `rawSourceRef` is present, it links to `/raw/{encoded ref}` via the same brass manifest-link style.
- **Drydock Actions card (`/queue/:patchId`).** Second right-rail card rendered **only when `meta.status === "pending" && source === "queue"`** — archived/accepted/rejected patches omit it. Contains an Approve button (brass fill) and a Reject toggle button (coral outline). Clicking Reject reveals an inline form with a required reason textarea (1–256 chars) and a coral-fill submit button. Approve requires a browser `confirm()` dialog; Reject requires a non-empty reason. The `confirm` and form-required checks are the user-intent gates before the irreversible fleet-wiki call. **Coral is permitted on surfaces that communicate destructive intent**: the reject submit button (fill), the reject toggle hover tint, and the `rejected` status dot. Coral fill is forbidden on non-destructive surfaces — Approve is brass, neutral chrome uses `surface-glass/surface-rim` tokens. Brass-led primary surfaces must never use coral fill.
- **Op-badge invariant.** Both `create_wiki` and `update_wiki` ops use **brass tone only** (background `--brass / 12%`, border `--brass / 35%`, text `--brass-bright`). They are distinguished exclusively by glyph (+ for CREATE, ↻ for UPDATE) and label text — never by color alone. The `op-badge--update` variant adds only a 1px aurora inset shadow as a micro-texture, not a primary fill. Aurora must not become the primary visual signal for either op.
- **Command palette.** Spring-pop entrance via `codex-pop`, glass card with stronger blur, search-icon prefix, `esc` kbd suffix, brass-dot active indicator on the result list.
- **Language toggle.** A `KO` / `EN` segmented control in the sidebar header upper-right, beside the brand compass-rose (wrapped together in `.sidebar-header-actions`). Both segments share one `.lang-toggle` container (`var(--radius-xs)` outer radius, `--surface-glass` fill, `--surface-rim` border). The active segment uses brass-led styling (`--brass-bright` text, `color-mix(in oklch, var(--brass) 12%, transparent)` fill, `--brass-glow` text-shadow). The toggle must not use aurora for any state, must not replace or obscure the compass-rose brand mark, and must use only existing `--surface-*`, `--brass*`, and `--radius-*` design tokens — no new colors, radii, or font families. On click it calls `setLanguage()` which persists to `localStorage["fleet-wiki-lang"]`, updates `<html lang>`, and triggers a full shell re-render without page reload. Owned by `client/src/components/lang-toggle.ts`; styles in `components.css` under the `sidebar-header-actions` and `lang-toggle` selectors.

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
9. Uses aurora as a primary fill on the op-badge — op-badge must remain brass-primary with glyph+label as the sole distinguishing signal between CREATE and UPDATE.

10. Add a POST handler outside the `/api/queue/:id/approve|reject` whitelist, except `POST /api/admin/workspaces` when authenticated by the daemon lockfile bearer token.
11. Bypass or weaken the `Origin` header guard on queue POST handlers — same-origin `http://127.0.0.1:${port}` check is the CSRF defense; removing it is a security regression. The CLI-only admin registration POST uses bearer auth instead and must not replace the queue Origin guard.
12. Translate branded Maritime Codex vocabulary in any locale dictionary or component — the following must remain identical in both `ko` and `en` dictionaries and must not be localized as user-visible prose: `CONTENTS`, `MANIFEST`, `Drydock`, `Codex`, `Maritime Codex`, `Manifest · Raw Source`, `MANIFEST · CODEX`, `MANIFEST · PATCH`, `MANIFEST · DRYDOCK`, `MANIFEST · DIAGRAM`, `Fleet · Codex`.
13. Set Mermaid `securityLevel: "loose"`, call Mermaid `bindFunctions`, relax the CSP in `src/security-headers.ts`, expand the global markdown `sanitizeConfig` with SVG profiles to accommodate diagrams, or change Mermaid `look` away from `"handDrawn"` (e.g. to `"classic"`) — the hand-drawn sketchy stroke is a visual-consistency invariant of the diagram block. The Mermaid hydrator's isolated SVG sanitize must remain confined to `client/src/markdown/diagrams.ts`.
14. Inserting `.toc-panel` as a grid column inside `<article class="document">` to reduce content width — the `.document-with-toc` pattern is strictly forbidden. ToC must remain in the right rail.

Items 1–14 are doctrine; reviewers should request a fix or an explicit doctrine update in this file before approval.

## Security Boundaries

The web surface is a defense-in-depth layer over the `fleet-wiki` leaf package. Because `fleet-wiki` doctrine forbids modifying its read path, every server-side guard lives here:

- **Path traversal defense.** `src/routes.ts` validates entry IDs with `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and rejects encoded slashes before any fleet-wiki call. The same file's `resolveSafeRawPath()` enforces that `/api/raw?ref=...` payloads start with `raw/`, contain no traversal segments, and resolve to an absolute path that is contained inside `paths.rawDir`; fleet-wiki cannot expose `assertSafeRawSourceRef` due to leaf doctrine, so this contained-by-`raw/` check is the package's own first-line defense. `SAFE_PATCH_ID` (`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$`) gates every `/api/queue/:patchId` call; `resolveSafeQueuePath()` enforces containment inside `queueDir` or `archiveDir` before any file read. Tests under `tests/security-routes.test.ts`.
- **Markdown XSS defense.** `client/src/markdown/renderer.ts` runs every `marked` output through DOMPurify with a `javascript:`/`data:` scheme block and only then injects via `innerHTML`. Tests under `tests/security-markdown.test.ts`.
- **Method whitelist.** Top-level request handler accepts only `GET`, `HEAD`, and `POST`. Browser-facing POST is restricted to the `/api/queue/:patchId/approve|reject` whitelist with strict `Origin: http://127.0.0.1:${port}` header equality. The only non-queue POST exception is CLI-only `POST /api/admin/workspaces`, which requires `Authorization: Bearer <lockfile token>`. All other paths receiving POST return `405` with `Allow: GET, HEAD`. Non-POST/GET/HEAD methods return `405` with `Allow: GET, HEAD, POST`. Malformed URLs return `400` instead of throwing an unhandled rejection.
- **Lockfile.** Per-user daemon lock directory at `0700`, lockfile `/tmp/fleet-wiki-{uid}/fleet-wiki-daemon.lock` at `0600` opened with `wx`, symlinks rejected via `lstat`. The payload is runtime-only: `{pid, port, host, startedAt, token}`. Workspace metadata is daemon memory only and is never persisted in the lockfile. `src/lock.ts` and `tests/security-lock.test.ts`.
- **CORS / binding.** Server binds to `127.0.0.1` only and never sets `Access-Control-Allow-Origin: *`. Adding either is a regression.
- **SPA fallback.** Static-file misses fall back to `client/index.html` only when (a) the path does not start with `/api/` or `/assets/` and (b) the path has no file extension. This is the discipline that lets `/entry/:id` and `/raw/:ref` survive a hard refresh or new-tab open without breaking the API/asset 404 contracts.
- **Stale server auto-restart.** When `fleet-wiki` CLI reuses an existing lock (`isProcessAlive` + health check pass), it additionally compares `lock.startedAt` with `dist/server.mjs` mtime via `isStaleLock()` (`src/stale.ts`). If the lock predates the current build, it sends SIGTERM (200ms grace, then SIGKILL), removes the lock, and respawns. This ensures a newly built dist is always served. Set `FLEET_WIKI_NO_AUTO_RESTART=1` to suppress and reuse the old server regardless of build age.
- **Queue counts invariant.** `GET /api/queue` always fetches both pending and archive listings regardless of the `status` query parameter. `pendingCount` and `archivedCount` in the response reflect actual listing sizes — they never silently drop to 0 because of the status filter. The `items` array is filtered by status; the counts are not.
- **POST method whitelist.** The server accepts `GET`, `HEAD`, and `POST`. Within browser-facing POST, only two routes are whitelisted: `POST /api/queue/:patchId/approve` and `POST /api/queue/:patchId/reject`. Each queue POST handler requires the `Origin` header to equal exactly `http://127.0.0.1:${port}` — missing or mismatched origin returns `403 origin_mismatch`. CLI-only `POST /api/admin/workspaces` is the sole exception and requires the daemon lockfile bearer token. Body is limited to 1 KB; reject reason is 1–256 characters (after trim). Do not add broad POST handlers beyond these explicit routes.

Do not relax any of these guards in the name of design or developer convenience.

## Change Control

Edits to design tokens (`theme.css`), spatial scale (`layout.css`), or component identity anchors (`components.css` + the corresponding component renderers) must be accompanied by an update to the relevant section of this file in the same commit. Tokens and doctrine drift in lockstep — that is the only way the visual identity stays stable across future contributions.
