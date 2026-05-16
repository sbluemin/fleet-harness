coding-agent model cycling — post scoped-models removal scope note

The current state of model management in @sbluemin/fleet-coding-agent has been simplified by removing the dedicated "scoped-models" UI. 
- The active model pool is defined at startup via the "--models" CLI flag.
- Users cycle through the available pool using "Ctrl+P" (next) and "Shift+Ctrl+P" (previous).
- Direct selection is available via the "/model" slash command.
- Interactive per-session reordering or persistent subset configuration (legacy "scoped-models") is explicitly out of scope and removed to reduce complexity.