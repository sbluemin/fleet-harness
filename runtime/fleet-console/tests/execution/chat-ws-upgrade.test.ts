import { describe, expect, it, vi } from "vitest";

import { createPluginTerminalUpgradeHandler } from "../../core/host/terminal/ws.js";
import type { TerminalTicketContext } from "../../core/host/terminal/terminal-types.js";

function context(overrides: Partial<TerminalTicketContext> = {}): TerminalTicketContext {
  return { cwd: "/tmp", sessionId: "op-1", ...overrides };
}

describe("terminal upgrade chat channel", () => {
  it("destroys a chat upgrade when no chat attach is bound", () => {
    const canAttach = vi.fn(() => false);
    const handler = createPluginTerminalUpgradeHandler({
      tickets: { consume: () => context({ channel: "chat" }) },
      sessions: { canAttach, attach: vi.fn(), attachViewer: vi.fn() } as never,
      isAuthorized: () => true,
    });
    const socket = { destroy: vi.fn() };
    const handled = handler.handleUpgrade({
      req: { url: "/api/v1/terminal/ws?ticket=chat" } as never,
      socket: socket as never,
      head: Buffer.alloc(0),
      pathname: "/api/v1/terminal/ws",
    });
    expect(handled).toBe(true);
    expect(canAttach).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();
  });
});
