# Fleet Wiki Workspace Schema

This directory defines workspace-local operating conventions for `.fleet/knowledge`.

## Maintainer Role

- Treat `wiki-schema.md` as the first reference for Fleet Wiki entry shape, links, provenance, and lint expectations.
- Preserve user edits. Automated setup may create missing default files, but must not overwrite existing schema files.
- Prefer additive schema updates through reviewed patches when conventions evolve.

## Scope

- Applies to `.fleet/knowledge/wiki/`, `.fleet/knowledge/raw/`, `.fleet/knowledge/queue/`, `.fleet/knowledge/archive/`, `.fleet/knowledge/conflicts/`, and `.fleet/knowledge/index.json`.
- Does not grant permission to bypass the human approval queue.
