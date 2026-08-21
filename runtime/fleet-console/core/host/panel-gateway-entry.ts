/**
 * Entry a panel gateway process runs.
 *
 * Deliberately its own bundle rather than a subcommand of `cli.mjs`. Measured 2026-08-22: a
 * gateway child booted through the full Console entry cost 85.3 MiB of physical footprint against
 * a 10.8 MiB bare-Node floor, because that bundle carries the server, the plugin host, and every
 * built-in the gateway never touches. A panel is meant to pay for its own connections, not for a
 * second copy of the Console.
 */
import { runPanelGateway } from "./panel-gateway.js";

await runPanelGateway().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
