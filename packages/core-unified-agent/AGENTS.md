# core-unified-agent

Provider-neutral SDK for supported Agent CLI backends.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/client/` | Unified client contract and provider specializations |
| `src/connection/` | ACP and provider-native transports |
| `src/config/` | Provider catalog and capability metadata |
| `src/models/` | Model registry and validation |
| `src/types/`, `src/service-status/` | Shared protocol and status contracts |
| `src/detector/`, `src/utils/` | CLI discovery and process support |
| `tests/unit/`, `tests/e2e/`, `tests/manual/` | Isolated, real-CLI, and manual verification |

## Constraints

- Keep Fleet orchestration, persona, and host policy out of this package.
- Provider transport, prompt injection, configuration, and reset/resume differences are normalized behind provider client and connection seams.
- `src/config/CliConfigs.ts` (`CLI_BACKENDS`) is the source of truth for provider IDs and transport/spawn capabilities; `models.json` owns provider model and effort metadata.
- Provider clients use the shared environment-sanitization and process-termination paths; do not add provider-local spawn or kill behavior.
- Service status is a shared type contract only. Collection and polling lifecycle belong to consumers.
- External protocol schemas are authoritative; do not invent local protocol variants to simplify a provider seam.
