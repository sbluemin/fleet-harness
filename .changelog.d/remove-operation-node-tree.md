---
section: Changed
---
- [fleet-console] Removed the parent/child Operation tree concept; the Operations canvas no longer renders the command tether and every Operation is a top-level item.
- [fleet-console] Console durable state is simplified to a single `operations` collection. The on-disk schema is bumped without a migration path, so existing `state.json` files are reset on first boot and previously registered Theaters and Operations are forgotten.
- [fleet-console] The plugin SDK API version is bumped for the operations contract change, so external plugins built against the previous SDK are now rejected as incompatible instead of failing at runtime.
