---
section: Changed
---

- [fleet-console] Extract shared markdown renderer and Mermaid hydrator into the `@fleet-console/markdown` workspace package so Codex reading and built-in plugin previews share one implementation.
- [fleet-console] file-explorer `.md` preview now uses the same markdown engine and styles as Codex (GFM, syntax highlighting, Mermaid diagrams, code toolbar).
