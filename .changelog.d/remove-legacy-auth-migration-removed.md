---
section: Removed
---
- [fleet-infra] [fleet-cli] [fleet-console] Removed the automatic migration of legacy auth credentials from the old `~/.fleet/agent/auth.json` location; Fleet now reads and writes only `~/.fleet/auth.json`, so credentials left in the old location are no longer picked up and must be re-added with `fleet auth login`.
