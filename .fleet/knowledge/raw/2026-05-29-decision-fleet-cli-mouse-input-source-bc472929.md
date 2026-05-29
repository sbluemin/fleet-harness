---
id: "decision-fleet-cli-mouse-input-source"
created: "2026-05-29T02:47:01.251Z"
sourceType: "inline"
title: "fleet-cli 마우스 입력 아키텍처 결정 히스토리"
tags: ["decision-history", "fleet-cli", "mouse-input", "controls", "cognitive-debt"]
contentHash: "bc472929"
---
Baseline `ca67779b` current end-to-end mouse input flow captured by carrier_dispatch carrier `e8391b98-9190-4b00-9ee9-311e0d66f93e` (Vanguard):
- outer terminal stdin → attachInputStream(ui) → ui.emitInput(data) → router.route(csiUNormalizer.normalize(data))
- SGR mouse parsing: parseSgrMouseInput (regex /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/) → getWheelDirection(64=up,65=down)
- routeMouseInput hit-test → dedicated pane: createDedicatedMouseRouter (render.ts:55-82)
  - mouseTrackingEnabled true → encodeSgrMouseInput → ptyHost.write (child PTY)
  - wheelDirection !== null + alt buffer → ptyHost.write("\x1b[A"|"\x1b[B")
  - wheelDirection !== null + normal buffer → ptyView.scrollLines(-3|+3) via scrollXtermLines
  - wheelDirection === null (button click) → return true (consume silent)
- outer terminal mouse mode: TUI start `\x1b[?1000h\x1b[?1006h`, TUI stop `\x1b[?1006l\x1b[?1000l`
- mouseTrackingEnabled calculation: activeProtocol ∈ ["vt200","drag","any"] && activeEncoding === "sgr" (pty.ts:341-347)
- MIRROR/DEDICATED toggle via Ctrl+T (`\x14`) — cursor sync policy only, does not affect PTY input routing.

Design review by carrier_dispatch taskforce `3e0d19c7-b501-4619-ae86-c215a3208f51` (Nimitz, Codex + Claude):
- Codex bottom line: C is recommended; Claude /tui default emits motion-capable app-mouse; host does not need selection semantics if Claude consumes drag itself; B is tmux copy-mode reimplementation and not MVP.
- Claude bottom line: C overwhelmingly realistic; B is a massive undertaking (selection state machine, clipboard, multi-click, scrollback, tmux integration); refactor mouse into src/controls/mouse/ subsystem simultaneously.
- Ground-truth closure step: verify `?1002h` emission from Claude /tui via child stdout DEC private mode capture before proceeding.
- Escalation trigger: if Claude /tui does NOT emit `?1002h`/`?1003h` and does NOT consume synthetic drag SGR, C is discarded and B or hybrid re-evaluated.
- Watch out for: motion event volume surge under `?1002h` (need micro-throttle assessment), tmux mouse forwarding variations, native selection and app-mouse capture are mutually exclusive in the same pane.
