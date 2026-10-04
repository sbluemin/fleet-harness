# Font Picker

`@fleet-console/font-picker` is a source-only, controlled, product-neutral font browser shared by Console surfaces.

## Constraints

- Discovery reflects the rendering device: the Console host lists its own fonts, and a renderer may enumerate its local fonts once permission is granted — by the user, or by Fleet Desktop for its own loopback Console and for remote origins the user allowed — and never before. Host and renderer classify through the shared Node-free heuristics here. Consumers own filtering, selection, preview content, and persistence.
- Renderer font lists are a fingerprinting surface: keep them in renderer memory only — never send them to the server, persist them in settings or browser storage, or log them. Only the chosen family name is persisted.
- Do not import Console core or plugin implementations.
