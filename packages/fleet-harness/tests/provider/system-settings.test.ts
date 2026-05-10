import { describe, expect, it, vi } from "vitest";
import { createFleetUpdatePrompt, FLEET_ROOT, registerSystemSettingsCommand } from "../../src/system.js";

describe("system settings command", () => {
  it("legacy guard option 없이 update action만 노출한다", async () => {
    let handler: ((args: unknown, commandCtx: any) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const notify = vi.fn();
    const select = vi.fn(async (_title: string, options: string[]) => {
      expect(options).toEqual(["fleet-harness 업데이트 실행"]);
      return options[0];
    });

    const pi = {
      registerCommand: vi.fn((_name: string, command) => {
        handler = command.handler;
      }),
      sendUserMessage,
    };

    registerSystemSettingsCommand(pi as any);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "fleet:system:settings",
      expect.objectContaining({
        description: "시스템 설정 (업데이트)",
      }),
    );

    await handler?.({}, { ui: { select, notify } });

    expect(sendUserMessage).toHaveBeenCalledWith(createFleetUpdatePrompt(FLEET_ROOT));
    expect(notify).toHaveBeenCalledWith("fleet-harness 업데이트 작업을 AI에게 전달했습니다.", "info");
  });
});
