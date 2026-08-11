import path from "node:path";

import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createDefaultExecutor } from "./server/cli.js";
import { handleSummary } from "./server/handler.js";
import { createLedgerService } from "./server/service.js";

export default definePlugin({
  id: "ledger",
  register(ctx) {
    const cliHome = path.join(ctx.host.paths.pluginDataDir("ledger"), "cli");
    const service = createLedgerService({
      cliHome,
      executor: createDefaultExecutor(cliHome),
    });
    registerRouter(ctx, "summary", async ({ req, res }) => {
      await handleSummary(req, res, ctx, service);
      return true;
    }, { method: "GET", path: "", summary: "Read Ledger usage summary.", category: "Ledger Plugin", gate: "origin-write", transport: "http" });
  },
});
