# Sections

Host-specific default Fleet PTY content.

`default-sections.ts` composes the lower-pane blue wireframe from fleet status, carrier roster, and jobs line sections. These files consume the generic Fleet PTY surface only through `src/tui/pty/fleet/api.ts`; they are not part of the reusable `src/tui/**` engine.
