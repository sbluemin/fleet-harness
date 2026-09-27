# Measurement and attribution

Read when choosing benches, reading traces, or proving a cause. Get the page WebSocket from `agent-browser --session <id> get cdp-url` plus the browser's `/json/list` (the `page` target on the Console origin). The scripts below speak raw CDP from Node's global `WebSocket` and never activate the window.

## Benches

| Question | Tool | Signal |
|---|---|---|
| Does a keystroke cost more than a frame? | [`scripts/cdp-type-bench.mjs`](../scripts/cdp-type-bench.mjs) `<pageWs> composer\|control\|terminal <chars> [bucket]` | per-char latency to the next frame and main-thread task/script/style/layout ms per char |
| Does idle or streaming cost grow over time or with use? | [`scripts/cdp-metrics-sample.mjs`](../scripts/cdp-metrics-sample.mjs) `<pageWs> <out.jsonl> <intervalSec> <count>` in the background | heap, DOM nodes, JS listeners, and per-interval task/style/script deltas |
| Which selector turns one change into a document-wide recalc? | [`scripts/cdp-invalidation-trace.mjs`](../scripts/cdp-invalidation-trace.mjs) `<pageWs> <chars>` with the target focused | subtree-invalidating selectors and the stack of large `UpdateLayoutTree` passes |
| What runs during a drag? | agent-browser `mouse down/move/up` between `profiler start` and `profiler stop` | `UpdateLifecycle`, style/layout, `Commit`, forced layouts, hot functions |

Always run the `control` target (an injected plain textarea) next to `composer` or `terminal`. In the benchmark, `focus` must report `ok` and `final length` must equal the typed count; otherwise the characters went elsewhere and the run is invalid. Pooled chat bodies are in the DOM but `inert`; the script picks the non-inert, on-screen composer.

For growth, record a quiet baseline first, then perform the usage pattern (visit panels, stream, toggle modes) and keep sampling. Interleaved interactions contaminate an interval — mark them.

## Attribution

- **Hot JS in a minified bundle:** fetch the served `assets/index-*.js`, take the function name, line, and column from the profile's call frame, and print the surrounding source slice; it maps back to one source site.
- **Style recalculation:** `UpdateLayoutTree.args.elementCount` in thousands per keystroke or per stream delta means a broad invalidation. `Blink.ForcedStyleAndLayout` inside `EventDispatch` means a handler read layout after something dirtied it (for example, textarea autosize reading `scrollHeight`).
- **Invalidation tracking** (`disabled-by-default-devtools.timeline.invalidationTracking`) names the anchor: `Affected by :has()` followed by `Invalidation set invalidates subtree` on `BODY` indicates a `:has()` anchored high in the tree with a broad right side (`*`, `> :not(...)`). Node insertion and text changes anywhere trigger it; inline style changes may not — test each mutation kind separately.
- **Render amplification:** count component renders per interaction with a cheap proxy (for example, wrapping `ResizeObserver` construction when a component creates one per render) and compare with the mode or feature toggled off.

## Causal proof and fix check

1. In the read-only client, delete the suspected CSS rules through CSSOM (walk nested grouping rules) or inject the replacement code, then rerun the identical bench. Report both runs.
2. After implementing, build the client to a scratchpad `--outDir` (never over the served `dist` of a running Console) and confirm the old selectors are absent from the emitted CSS; inject the committed rules/code into a freshly reloaded client and rerun.
3. Replacing `:has()` with an attribute or class can lower specificity; list every competing rule for the affected properties and confirm the new selector still wins.

## Pitfalls

- zsh does not word-split unquoted variables: loop over files instead of `grep $LIST`.
- A reload restores removed rules; a bench after an earlier injection in the same page is not a baseline.
- Headless clients run with accessibility enabled by the automation driver; accessibility time is real in that client but not proof about the user's renderer.
- `git blame` shows the last edit of a line. Use `git log -S'<selector>' --reverse` for when a pattern was introduced, and look for later changes that grew the DOM when an old pattern only recently became noticeable.
