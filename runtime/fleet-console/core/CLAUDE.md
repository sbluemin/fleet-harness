# Console Core

Core owns composition, transport admission, plugin adapters, and global chrome. Product state and feature-specific route behavior belong to `../features/`.

- Keep shared startup, cleanup, and plugin rollback ordering explicit. Use injected dependencies, never a service locator.
- Host transport preserves listener identity, Host/Origin admission, the one-use terminal ticket, and the single Operation event stream.
- Client composition wires feature APIs and shared chrome; browser code remains Node-free. Ephemeral panels do not own persistent session lifetimes.
- The bootstrap is the sole durable writer coordinator. Feature extraction must preserve atomic state snapshots, deletion safeguards, and dormant restoration.
