---
id: "prd-admiral-protocol-single-immutable-fleet-action-source"
created: "2026-05-24T07:51:25.117Z"
sourceType: "inline"
title: "PRD: Admiral Protocol 영역의 Multi-Protocol 추상화 폐기 — Fleet Action을 단일 불변 프롬프트로 단일화"
tags: ["admiral", "protocols", "doctrine", "decision-history", "cognitive-debt"]
contentHash: "b0ee5e98"
---
## Raw Evidence — Admiral Protocol Abstraction Removal Decision

### Evidence 1: Pre-removal code inventory (carrier job result)

The prior carrier:vanguard job (f4a80b15-110e-427a-a9c9-735c8798a3af) performed a thorough scan of `runtime/fleet-cli/src/admiral/protocols/` and found:

1. `AdmiralProtocol` interface at `types.ts:13-25` — defined `id`, `name`, `shortLabel`, `slot`, `color`, `prompt` fields.
2. `PROTOCOLS` array at `index.ts:34-36` — contained exactly one entry (`FLEET_ACTION`).
3. `setActiveProtocol` exported at `index.ts:41-46` — **zero call sites** in `src/`.
4. `getActiveProtocol()` at `index.ts:58-65` — always resolved to `FLEET_ACTION`.
5. `getAllProtocols()` at `index.ts:53-55` — returned the 1-element array, consumed only by `admiral/prompts.ts`.
6. `getProtocolById()` at `index.ts:76-78` — linear search on 1-element array.
7. `ProtocolSettings` at `index.ts:25-27` and mirrored `AdmiralSettings` at `prompts.ts:23-25` — unused settings key `"admiral"`.
8. `runtime/provider.ts` — imported `getActiveProtocol()` solely to expose `activeProtocol: getActiveProtocol().name`.

### Evidence 2: Phantom features in pre-removal AGENTS.md

Pre-removal `AGENTS.md` documented:
- `border-bridge` UI integration (`setEditorRightLabel`, `setEditorBottomRightLabel`, editor border color) — **no actual code** in `runtime/fleet-cli/src/`.
- `Alt+1` ~ `Alt+9` protocol slot keybindings — **no keybinding registration code**.
- Settings Popup "Admiral" section — **no Settings popup code** referencing protocols.

### Evidence 3: Post-removal code state

Post-removal files (current branch `feat-enhance-protocol`):

- `fleet-action.ts`: exports only `FLEET_ACTION_PROMPT`, `FLEET_ACTION_LABEL`, `FLEET_ACTION_COLOR`. No `AdmiralProtocol` import.
- `index.ts`: stripped of `PROTOCOLS`, `getAllProtocols`, `getActiveProtocol`, `setActiveProtocol`, `getProtocolById`. Re-exports only `standingOrders` and completion-report builders.
- `prompts.ts`: `getAllProtocols()` call removed. `FLEET_ACTION_PROMPT` inlined directly into `<fleet section="protocols">`.
- `fleet-status-section.ts`: imports `FLEET_ACTION_LABEL` / `FLEET_ACTION_COLOR` directly; no `getActiveProtocol()`.
- `types.ts`: deleted.
- `runtime/provider.ts`: deleted.
- `AGENTS.md`: rewritten to reflect single immutable protocol doctrine.

### Evidence 4: Grand Fleet independence

`src/grand-fleet/prompts.ts:220-226` contains `FLEET_ACP_PROTOCOL_PROMPT` as a self-contained inline string with no import from `admiral/protocols`. This confirms the two protocol concerns (Admiral vs Grand Fleet) were already decoupled before this decision.