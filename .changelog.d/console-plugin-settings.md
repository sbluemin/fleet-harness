---
section: Added
---

- [fleet-console] Add `ClientSettingsCapability` to the plugin SDK — plugins can now read and write per-server durable settings via `GET`/`PUT /api/v1/settings/plugins/:pluginId`, persisted in the console `settings.json` under the `plugins` record and surviving browser changes and console restarts.
- [fleet-console] Migrate Terminal plugin font (name + size) to server-side persistence via `ClientSettingsCapability`; Terminal Font now survives browser changes and console restarts, with a one-time local-storage seed migration on first load.
