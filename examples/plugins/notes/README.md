# Notes Plugin

Sample external Fleet Console client plugin.

- `plugin.json` declares `apiVersion: 1`, a browser client entry (`client/index.tsx`), and an optional routes entry (`routes.ts`).
- `client/index.tsx` imports only React and `@fleet-console/sdk/*` browser modules. The console runtime shims share the host's React and SDK singleton, so the plugin does not bring its own React copy.
- `routes.ts` exposes a minimal `/plugins/notes/info` backend route with display-safe metadata only.

External plugins run in the host Node process and share the browser origin; see `runtime/fleet-console/AGENTS.md` for the trust model and safety guards.

To test the external discovery path, copy this directory to `~/.fleet/plugins/notes` in an isolated HOME and restart the console.
