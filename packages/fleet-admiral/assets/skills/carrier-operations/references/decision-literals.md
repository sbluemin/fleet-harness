# Decision Literal Checklists

Load this reference only when a dispatch still contains concrete value choices after scope and design decisions are settled. Copy the relevant decision table verbatim into the Carrier's request blocks; do not load unrelated domain checks.

## Decision Table

| Decision | Literal value | Existence evidence | Prohibited substitutions | Verification |
|---|---|---|---|---|
| `<choice>` | `<exact value>` | `<source of truth>` | `<forbidden alternatives>` | `<command or assertion>` |

## Design Example

- Fix exact token names and verify that each exists in every supported theme.
- Fix mix ratios and easing tokens as literals.
- Attach greps for raw values, undefined tokens, and retired tokens.

## Contract and Configuration Example

- Fix exact API paths, setting keys, protocol tokens, and public names.
- Verify each literal against the current route, schema, registry, or configuration source.
- Attach greps for alternate names, deprecated keys, and raw fallback values.
