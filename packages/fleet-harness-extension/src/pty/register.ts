/**
 * core-shell — 확장 진입점
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { isShellPopupOpen, openShellPopup, setShellPopupContext } from "./shell.js";
import { getShellPopupBridge, setShellPopupBridge } from "./overlay.js";

export default function interactiveShellExtension(pi: ExtensionAPI) {
  const service = {
    open: openShellPopup,
    isOpen: isShellPopupOpen,
  };

  const registerBridge = () => {
    setShellPopupBridge(service);
  };

  pi.on("session_start", (_event, ctx) => {
    setShellPopupContext(ctx);
    registerBridge();
  });

  pi.on("session_shutdown", () => {
    const current = getShellPopupBridge();
    if (current === service) {
      setShellPopupBridge(null);
    }
  });

  registerBridge();
}
