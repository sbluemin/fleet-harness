# fleet-style Doctrine

`packages/fleet-style` is the Fleet CLI/help brand style package. It is a zero-runtime-dependency workspace leaf for shared terminal help presentation assets.

## Must Own

- Fleet CLI/help brand style assets.
- ANSI paint helpers used by CLI help output.
- Fleet banner and palette tokens.
- TTY and `NO_COLOR` token helpers for terminal help text.

## Must Not Own

- Help text builders.
- CLI argument parsers.
- `fleet-tui` rendering primitives.
- Fleet Wiki server behavior.
- Domain logic.
- Process spawning.
- Web-client design tokens.

## Dependency Rules

- Keep runtime dependencies empty.
- Use ESM-only TypeScript with `NodeNext`.
- Public consumers import from the package root export only.
- Do not mutate `process.env`; helper APIs must accept explicit environment options.
