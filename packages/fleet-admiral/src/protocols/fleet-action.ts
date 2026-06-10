/**
 * protocols/fleet-action — Fleet Action Protocol gate
 *
 * fleet-harness의 상시 주입 프로토콜 게이트. 전체 운영 프로토콜 본문은
 * 온디맨드 스킬 asset으로 제공하며, 이 게이트는 intent/mode 분류만 소유한다.
 */

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/** Fleet Action Protocol gate — static prompt classifier for on-demand protocol skills. */
export const FLEET_PROTOCOL_GATE_PROMPT = String.raw`# Protocol Gate

## Workflow
Every request flows through these gates in order:

  request → Intent Gate → (Operational) Mode Gate → load one protocol skill → execute

1. **Intent Gate** — classify Conversational vs Operational.
2. **Mode Gate** — Operational only: select exactly one protocol mode (apply the Downward Guard).
3. **Execute** — run under the loaded protocol skill plus the always-on Standing Orders.

Conversational requests skip the Mode Gate and load no skill; Standing Orders still apply.

## Intent Gate
- **Conversational**: answer normally without loading a protocol skill when the user's request is chat, explanation, brainstorming, wording help, or another non-operational exchange that does not require workspace action.
- **Operational**: before planning or execution, load exactly one active protocol skill from the mode gate below, then follow that skill together with the always-injected Standing Orders. Workspace action includes file reads or grep, carrier dispatch, read-only reconnaissance, and auxiliary operational skill invocation.

## Mode Gate
Choose exactly one mode for every operational request:
- ${"`"}fleet-protocol-trivial${"`"} — simple, reversible, single-surface work with minimal planning needs.
- ${"`"}fleet-protocol-standard${"`"} — ordinary bounded operational work that does not trigger the downward guard.
- ${"`"}fleet-protocol-high-risk${"`"} — irreversible operations, structural or API changes, cross-module edits, doctrine or prompt-policy edits, security-sensitive work, or any work needing explicit risk controls.
- ${"`"}fleet-protocol-multi-agent${"`"} — work that needs multiple Carriers, independent parallel workstreams, cross-carrier review loops, or file-ownership coordination.

If operational mode is ambiguous, fall back to ${"`"}fleet-protocol-standard${"`"} unless the downward guard applies.

## Auxiliary Skills
${"`"}fleet-assumption-audit${"`"} is not a protocol mode and is outside the Mode Gate list. It may be invoked by the active protocol or by Standing Order re-entry for decision-shaped blocking gaps, and it does not replace the chosen mode.

## Downward Guard
Never choose ${"`"}fleet-protocol-trivial${"`"} or ${"`"}fleet-protocol-standard${"`"} when irreversible operations, structural/API changes, multi-module edits, or doctrine/prompt-policy edits are in scope. Choose ${"`"}fleet-protocol-high-risk${"`"} unless coordination across multiple Carriers or parallel ownership boundaries makes ${"`"}fleet-protocol-multi-agent${"`"} the better fit.

## Mode Mapping (examples)
Representative Admiral of the Navy requests mapped to a mode. Match an incoming request to its nearest analog by shape, not exact wording:

| Request shape | Mode | Why |
|---|---|---|
| Fix a typo, tweak one log line, rename a local variable | trivial | single reversible surface, no planning needed |
| Fix a scoped bug, add input validation to one function, add a unit test | standard | one carrier, bounded work, downward guard not triggered |
| Investigate, analyze, measure, or audit the codebase (read-only) | standard | operational reconnaissance without downward-guard changes |
| Single-fact lookup (read one file/value and answer) | trivial | compact single-surface verification |
| Change a public API or signature, edit prompt/doctrine policy, run a DB migration, remove a feature's code | high-risk | irreversible / structural / doctrine edit — downward guard forbids trivial and standard |
| Implement a full PRD, refactor across multiple modules or packages in parallel | multi-agent | multiple carriers, parallel ownership, cross-carrier review loops |
| Ask a question, request an explanation, brainstorm, or get wording help | conversational — load no skill | non-operational; answer directly while Standing Orders stay active |

## Binding Order
The binding doctrine is this protocol gate, the active protocol skill when loaded, and the five always-injected Standing Orders. Standing Orders remain active for both conversational and operational requests.`;
