# Terminal Plugin Doctrine

`runtime/fleet-plugins/terminal` owns the built-in Fleet Console Terminal plugin.

## Settings Ownership

- The Terminal plugin owns `/plugins/terminal/settings`.
- `GET /plugins/terminal/settings` returns the Terminal prompt settings DTO. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/settings` requires the terminal Origin authorization gate and updates only Terminal prompt settings.
- The Terminal plugin owns two separate Settings sections: `Agent CLI` and `System Prompt`.
- `System Prompt` owns `replaceSystemPrompt` and `enableMetaphor` UI controls for Terminal-launched agent sessions.
- Prompt settings persist through `@dotobokuri/fleet-infra` global options in `~/.fleet/settings.json`. Do not move these settings into plugin storage.
