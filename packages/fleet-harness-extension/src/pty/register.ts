// core-shell -- 확장 진입점

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { setShellPopupContext } from "./shell.js";

export default function interactiveShellExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    setShellPopupContext(ctx);
  });
}
