import { promises as fs } from "node:fs";
import path from "node:path";

import { definePlugin } from "@fleet-console/sdk/plugin/node";

import { registerChatRoutes } from "./server/chat-routes.js";

export default definePlugin({
  id: "scuttlebutt",
  name: "Quaker Aides",
  async register(ctx) {
    await fs.mkdir(path.join(ctx.host.paths.pluginDataDir("scuttlebutt"), "workspace"), { recursive: true });
    registerChatRoutes(ctx);
  },
});
