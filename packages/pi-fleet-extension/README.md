# @sbluemin/pi-fleet-extension

`@sbluemin/pi-fleet-extension` is the Pi adapter package for Fleet. It owns Pi runtime wiring, TUI surfaces, host shell integration, and domain-specific adapters while consuming `@sbluemin/fleet-core` through public exports.

## Domain Adapters

Pi-specific capabilities are organized into domain-mirroring adapters under `src/`:

### Large Domains (Subdirectories)
- **agent**: `AgentServices` adapter, Pi AI Provider registration, streaming, and Agent Panel UI
- **grand-fleet**: `admiralty` facade adapter, IPC, and GF session state
- **fleet-wiki**: `@sbluemin/fleet-wiki` adapter, tool/command registration, and overlays
- **shell**: Host shell surfaces (HUD, Welcome UI, Overlays) and shortcut registration

### Lean Services (Single Files)
- **fleet**: Core Fleet state and event adapters
- **metaphor**: Worldview and directive refinement wiring
- **job**: Fleet carrier job lifecycle and status tracking
- **settings**: Fleet-to-Pi settings synchronization
- **log**: Fleet log store and terminal output streaming
- **tool-registry**: Fleet tool spec to Pi tool registration loop

## Architecture

This package follows a **Flat Domain Architecture**. Instead of grouping code by Pi capability type (e.g., all commands in one folder), code is grouped by the Fleet domain it serves. This ensures that Pi registration logic lives alongside its corresponding domain adapter and UI.

The package consumes `@sbluemin/fleet-core` public exports to bridge Fleet's domain logic into the Pi environment.
