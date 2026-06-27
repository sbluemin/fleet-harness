# Terminal Plugin Doctrine

`runtime/fleet-plugins/terminal` owns the built-in Fleet Console Terminal plugin.

## Settings Ownership

- The Terminal plugin owns `/plugins/terminal/settings`.
- `GET /plugins/terminal/settings` returns the Terminal prompt settings DTO. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/settings` requires the terminal Origin authorization gate and updates only Terminal prompt settings.
- The Terminal plugin owns `/plugins/terminal/model-auth`.
- The Terminal plugin owns the model-auth provider whitelist and state builder.
- `GET /plugins/terminal/model-auth/state` returns the display-safe model sign-in DTO built by the Terminal plugin. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/model-auth/providers/:cli` and `DELETE /plugins/terminal/model-auth/providers/:cli` require the terminal Origin authorization gate and mutate provider API keys through `@dotobokuri/fleet-infra` auth storage.
- The Terminal plugin owns one Settings section: `Agent CLI`.
- The `Agent CLI` Settings section renders exactly three blocks in order: System Prompt / Metaphor, Model Sign-in, and Agent CLI Available.
- `Agent CLI` owns `replaceSystemPrompt` and `enableMetaphor` UI controls for Terminal-launched agent sessions.
- Prompt settings persist through `@dotobokuri/fleet-infra` global options in `~/.fleet/settings.json`. Do not move these settings into plugin storage.
- Model sign-in persists through `@dotobokuri/fleet-infra` auth service in `~/.fleet/auth.json`. Do not move API keys into plugin storage or browser payloads.
