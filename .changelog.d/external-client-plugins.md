---
section: Added
---

- [fleet-console] Fleet Console now discovers and loads third-party client plugins installed under `~/.fleet/plugins`, rendering their Operation panels and Settings sections alongside the built-in Terminal.
- [fleet-console] Plugins declare an `apiVersion` for compatibility; an incompatible or failing external plugin is skipped without breaking the console.
- [fleet-console] External plugin client code shares the console's React and SDK singleton through runtime shims, while plugin routes run in the host Node process under dedicated `/plugin-runtime/` endpoints.
