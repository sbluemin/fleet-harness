# Notes Plugin

Sample external Fleet Console client plugin.

- `plugin.json` declares `apiVersion: 1`, a browser client entry (`client/index.tsx`), and an optional routes entry (`routes.ts`).
- `client/index.tsx` imports only React and `@fleet-console/sdk/*` browser modules. The console runtime shims share the host's React and SDK singleton, so the plugin does not bring its own React copy.
- `routes.ts` exposes a minimal `/plugins/notes/info` backend route with display-safe metadata only.

External plugins run in the host Node process and share the browser origin; see `runtime/fleet-console/CLAUDE.md` for the trust model and safety guards.

To test the external discovery path, copy this directory to `~/.fleet/plugins/notes` in an isolated HOME and restart the console.

## Using `Select`

`@fleet-console/sdk/react/browser` exports a controlled `Select` component and a `useSelect` hook:

```tsx
import { Select, type SelectOption } from "@fleet-console/sdk/react/browser";

const VIEW_OPTIONS: SelectOption[] = [
  { value: "list",  label: "List"  },
  { value: "grid",  label: "Grid"  },
  { value: "table", label: "Table", disabled: true },
];

function ViewToggle() {
  const [view, setView] = React.useState("list");
  return <Select value={view} options={VIEW_OPTIONS} onChange={setView} label="View" />;
}
```

**Ownership:** The plugin owns `value`, `options`, and `onChange`. Selection state, persistence, and any domain-specific value translation belong to the plugin; the component only renders.

- **Disabled options** — set `disabled: true` on a `SelectOption` to make that entry unselectable without removing it from the list.
- **Compact variant** — pass `compact` to render a narrower trigger and a right-aligned popup suited to toolbars or inline controls.
- **CSS** — do not import `.fc-select*` styles. They are host-owned and applied automatically through the Console runtime; importing them separately will produce duplicate and possibly conflicting rules.
- **`useSelect`** — the documented escape hatch for bespoke shells that need listbox behavior without the default `<Select>` markup. Use `Select` by default; reach for `useSelect` only when the standard markup cannot accommodate your shell structure. Available types: `UseSelectOptions`, `UseSelectResult`.
