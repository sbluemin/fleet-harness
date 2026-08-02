/**
 * protocols/fleet-action — Fleet Action Protocol gate
 *
 * fleet-harness의 상시 주입 프로토콜 게이트. 전체 운영 프로토콜 본문은
 * 온디맨드 스킬 asset으로 제공하며, 이 게이트는 intent/mode 분류만 소유한다.
 *
 * 이 게이트는 classic doctrine 전용이다. gateway 경로는 protocol-* 스킬을 주입하지 않으므로
 * protocol-gate 블록 자체를 렌더하지 않는다.
 */

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

const PROTOCOL_GATE_HEAD = String.raw`# Protocol Gate

## Procedure
Every request flows through these gates in order:

  request → Intent Gate → (Operational) Mode Gate → load one protocol skill → execute

1. **Intent Gate** — classify Conversational vs Operational.
2. **Mode Gate** — Operational only: select exactly one protocol mode (apply the Downward Guard).
3. **Execute** — run under the loaded protocol skill plus the always-on Standing Orders.

Conversational requests skip the Mode Gate and load no skill; Standing Orders still apply.

Skill loading is idempotent per session: when a required skill's content is already loaded in this session's context, apply it without reloading.
`;

const PROTOCOL_GATE_INTENT = String.raw`## Intent Gate
- **Conversational**: answer normally without loading a protocol skill when the user's request is chat, explanation, brainstorming, wording help, or another non-operational exchange that does not require workspace action.
- **Operational**: before planning or execution, load exactly one active protocol skill from the mode gate below, then follow that skill together with the always-injected Standing Orders. Workspace action includes file reads or grep, carrier dispatch, read-only reconnaissance, and auxiliary operational skill invocation.
`;

const PROTOCOL_GATE_MODE = String.raw`## Mode Gate
Choose exactly one mode for every operational request:
- ${"`"}protocol-baseline${"`"} — simple, reversible, single-surface work with minimal planning needs.
- ${"`"}protocol-midline${"`"} — ordinary bounded operational work that does not trigger the downward guard.
- ${"`"}protocol-redline${"`"} — any Downward Guard trigger (defined below), security-sensitive work, or any work needing explicit risk controls.
- ${"`"}protocol-frontline${"`"} — work that needs multiple Carriers, independent parallel workstreams, cross-carrier review loops, or file-ownership coordination.

If operational mode is ambiguous, fall back to ${"`"}protocol-midline${"`"} unless the downward guard applies.
`;

const PROTOCOL_GATE_TAIL = String.raw`## Auxiliary Skills
${"`"}assumption-audit${"`"} is not a protocol mode and is outside the Mode Gate list. It may be invoked by the active protocol, by Standing Order re-entry for decision-shaped blocking gaps, or by the Command Integrity pre-engagement clarification trigger before a protocol mode loads, and it does not replace the chosen mode.

## Downward Guard
Never choose ${"`"}protocol-baseline${"`"} or ${"`"}protocol-midline${"`"} when irreversible operations, structural/API changes, multi-module edits, or doctrine/prompt-policy edits are in scope. Choose ${"`"}protocol-redline${"`"} unless coordination across multiple Carriers or parallel ownership boundaries makes ${"`"}protocol-frontline${"`"} the better fit.

## Mode Mapping (examples)
Representative user requests mapped to a mode. Match an incoming request to its nearest analog by shape, not exact wording:

| Request shape | Mode | Why |
|---|---|---|
| Fix a typo, tweak one log line, rename a local variable | baseline | single reversible surface, no planning needed |
| Fix a scoped bug, add input validation to one function, add a unit test | midline | one carrier, bounded work, downward guard not triggered |
| Investigate, analyze, measure, or audit the codebase (read-only) | midline | operational reconnaissance without downward-guard changes |
| Single-fact lookup (read one file/value and answer) | baseline | compact single-surface verification |
| Change a public API or signature, edit prompt/doctrine policy, run a DB migration, remove a feature's code | redline | irreversible / structural / doctrine edit — downward guard forbids baseline and midline |
| Implement a full PRD, refactor across multiple modules or packages in parallel | frontline | multiple carriers, parallel ownership, cross-carrier review loops |
| Ask a question, request an explanation, brainstorm, or get wording help | conversational — load no skill | non-operational; answer directly while Standing Orders stay active |

## Binding Order
The binding doctrine is this protocol gate, the active protocol skill when loaded, and the six always-injected Standing Orders. Standing Orders remain active for both conversational and operational requests.`;

/** Classic doctrine protocol gate body. gateway 경로는 이 블록을 렌더하지 않는다. */
export const FLEET_PROTOCOL_GATE_PROMPT = buildProtocolGatePrompt();

/** Classic doctrine protocol gate body. */
export function getProtocolGatePrompt(): string {
  return buildProtocolGatePrompt();
}

function buildProtocolGatePrompt(): string {
  return [
    PROTOCOL_GATE_HEAD.trimEnd(),
    PROTOCOL_GATE_INTENT.trimEnd(),
    PROTOCOL_GATE_MODE.trimEnd(),
    PROTOCOL_GATE_TAIL.trim(),
  ].join("\n\n");
}
