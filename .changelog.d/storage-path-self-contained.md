---
section: Changed
---
- [core-infra] Renamed package from `fleet-infra` to `core-infra` (`@dotobokuri/core-infra`) to reflect its Fleet-domain-agnostic nature; all consumers updated transparently.
- [core-infra] Moved the global-options store subpath to `@dotobokuri/core-infra/data-dir/settings`; the old `@dotobokuri/fleet-infra/global-options` export is removed.
- [fleet-admiral] [fleet-carriers] Data-dir resolution is now self-contained via `getFleetDataDir()` from `core-infra`; hosts no longer need to supply a `dataDir` argument at startup.
- [fleet-console] [fleet-cli] Removed `dataDir` host-injection from the console server and CLI runtime; each package resolves its own data directory without host assembly.
- [fleet-console] Removed `FleetPluginPathsHost.dataDir` from the SDK plugin contract; plugins no longer receive a raw data-directory path.
