import { describe, expect, it } from "vitest";

import { resolveChatLaunchEffort } from "../server/agent-api/chat-launch-effort.js";

describe("resolveChatLaunchEffort", () => {
  it("maps the ultra launch sentinel to xhigh plus session ultracode", () => {
    expect(resolveChatLaunchEffort("ultra")).toEqual({ effort: "xhigh", ultracode: true });
  });

  it("does not collapse ultra onto max — max is intensity without orchestration", () => {
    expect(resolveChatLaunchEffort("ultra")).not.toEqual({ effort: "max" });
    expect(resolveChatLaunchEffort("max")).toEqual({ effort: "max" });
  });

  it("forwards everyday rungs unchanged", () => {
    expect(resolveChatLaunchEffort("low")).toEqual({ effort: "low" });
    expect(resolveChatLaunchEffort("medium")).toEqual({ effort: "medium" });
    expect(resolveChatLaunchEffort("high")).toEqual({ effort: "high" });
    expect(resolveChatLaunchEffort("xhigh")).toEqual({ effort: "xhigh" });
  });

  it("drops empty and unknown values", () => {
    expect(resolveChatLaunchEffort("")).toBeUndefined();
    expect(resolveChatLaunchEffort("ultracode")).toBeUndefined();
    expect(resolveChatLaunchEffort("minimal")).toBeUndefined();
  });
});
