# Fleet Plugins

Built-in Console plugin implementations. Plugins are part of the Console product surface: the domain, security, and design doctrine in `runtime/fleet-console/AGENTS.md` applies here, and each plugin's own `AGENTS.md` adds plugin-specific rules within its scope.

## Constraints

- Plugin CSS falls under the Console `Design invariants`: colors are consumed only as theme tokens via `var()`/`color-mix`, chromatic raw literals are forbidden, and near-achromatic shadow/scrim/sheen depth literals are the sanctioned exception.
