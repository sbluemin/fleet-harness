---
section: Changed
---
- [core-infra] Renamed the Fleet infrastructure package to reflect its domain-agnostic role; all consumers are updated transparently with no behavior change.
- [fleet-admiral] [fleet-carriers] Data directory resolution is now self-contained, so carrier storage and marketplace assets always resolve to the single Fleet home directory no matter which host launches them.
- [fleet-console] [fleet-cli] Removed host-side data directory injection, fixing duplicate marketplace rendering and carrier settings that previously failed to persist when changed from the console.
- [fleet-console] Removed the raw data directory path from the plugin host contract so plugins no longer receive it.
