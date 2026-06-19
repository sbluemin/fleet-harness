---
section: Added
---

- [fleet-console] Console self-update flow applies a global `fleet-cli` + `fleet-console` update directly from the topbar button instead of opening an npm registry link.
- [fleet-console] Self-update blocks while a terminal Operation has a live PTY and rejects local/unpublished builds, then restarts the console on a fresh random loopback port and opens it in a new browser window.
- [fleet-cli] CLI update subsystem now shares the generic core-agent package-updater substrate while preserving CLI-specific shutdown and messaging lifecycle.
- [core-agent] Generic global package updater factory for package-manager detection, global-root checks, version resolution, install spawning, and manual fallback messages.
