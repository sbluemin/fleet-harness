# core-ai-gateway

Translates Anthropic Messages traffic onto non-Anthropic provider backends.

## Layer index

| Layer | Responsibility |
|---|---|
| `src/anthropic.ts` | Client-facing Anthropic protocol seam, in both directions |
| `src/canonical.ts` | Provider-neutral request/event vocabulary every adapter speaks |
| `src/openai-responses-adapter.ts`, `src/cursor-adapter.ts` | Provider wire formats |
| `src/models.ts`, `models.json` | Model catalog, context windows, effort ladders |

## Constraints

- Keep Fleet orchestration and persona semantics out of this package; it knows providers, not Carriers.
- The OpenAI path rewrites every compatible tool schema into strict mode and strips the resulting nulls back out on the way in. **These two are one mechanism.** Change either alone and arguments silently gain or lose meaning: a surviving null reads as a real value to the client, and an un-rewritten schema loses the omission guarantee.
- Strict compatibility is decided by an allowlist of JSON Schema keywords, never a denylist. The costs are asymmetric — judging a tool incompatible costs that one tool its guarantee, while wrongly admitting one returns a 400 that fails the entire request, every other tool included. Widen the allowlist only against an observed acceptance.
- The OpenAI adapter drops `response.function_call_arguments.delta` deliberately. Nulls cannot be stripped from a partial JSON fragment, so forwarding fragments would let the client reassemble un-stripped arguments. Restoring argument streaming reintroduces the defect.
- Strict mode makes omission expressible; it does not stop a model from filling an argument. Models still send the default quoted in a property's own description, and stating the omission rule in that description was measured to change nothing. Do not re-attempt schema-side persuasion — treat leftover default-valued arguments as accepted, since suppressing them cannot be distinguished from a caller who meant the default.
- The Cursor path has no equivalent guarantee. Its optional-argument pollution is known and unaddressed; do not assume parity between adapters.
- `FLEET_GATEWAY_WIRE_LOG` names a file to receive the inbound tool catalog, the canonical and provider wire bodies, and every response event as JSONL. It is inert when unset, and it is the only way to see the argument JSON a model actually produced — provider behaviour differences are not otherwise observable from either side of this package.
