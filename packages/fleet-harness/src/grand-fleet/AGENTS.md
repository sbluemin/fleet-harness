# grand-fleet

Owns the Pi-side Grand Fleet domain integration for `fleet-harness`. This domain mirrors the `admiralty` facade from `fleet-core`.

## Scope

- Admiralty/Fleet role detection and branch logic based on `PI_GRAND_FLEET_ROLE`
- Grand Fleet session state access through `@sbluemin/fleet-core/admiralty` public accessors
- Admiralty/Fleet IPC client/server runtime and session event wiring
- Grand Fleet domain-specific command, tool, keybind, and TUI registration
- Grand Fleet session lifecycle, prompt binding, and mission/report buffers

## Rules

- **Service Mapping**: Consume provider-agnostic Grand Fleet domain logic from the `@sbluemin/fleet-core/admiralty` public subpath or the root `admiralty` facade.
- **Registration**: All Grand Fleet-specific Pi capabilities must be registered within this domain, not in a global capability bucket.
- **Role Isolation**: Maintain clear isolation between Admiralty-only and Fleet-only registration logic.
- Do not bring provider registration or streaming logic into this domain; those belong in `src/agent/`.
- Preserve `registerGrandFleet`, `initGrandFleetState`, and `getState` export signatures for host compatibility.
