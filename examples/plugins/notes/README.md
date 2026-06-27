# Notes Plugin

Sample external Fleet Console client plugin.

- `plugin.json` declares `apiVersion: 1`, a browser client entry, and an optional routes entry.
- `client/index.tsx` imports only React and `@fleet-console/sdk/*` browser modules.
- `routes.ts` exposes a minimal `/plugins/notes/info` backend route with display-safe metadata only.

To test the external discovery path, copy this directory to `~/.fleet/plugins/notes` in an isolated HOME.
