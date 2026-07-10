---
section: Added
---

- [fleet-console] Add an ACP | App Server click toggle on the Codex row in Settings > Agent CLI; the choice persists in ~/.fleet/settings.json as codexLaunchMode and defaults to ACP.
- [core-infra] Persist codexLaunchMode (acp or app-server) in ~/.fleet/settings.json global options.
- [core-unified-agent] Route Codex carrier sessions through ACP or legacy App Server based on the CODEX_USE_ACP runtime environment toggle, defaulting to ACP when unset.
- [fleet-admiral] [fleet-cli] Apply the saved codexLaunchMode as CODEX_USE_ACP when launching new Codex carrier sessions.
