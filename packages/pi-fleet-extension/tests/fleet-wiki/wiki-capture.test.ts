import { describe, expect, it, vi } from "vitest";

import { collectCaptureSession } from "../../src/wiki/capture.js";
import { registerWikiCommands } from "../../src/wiki/ui.js";
import { runCapture } from "../../src/wiki/handlers.js";
import { buildWikiCaptureDirective } from "@sbluemin/fleet-wiki";

describe("wiki capture session", () => {
  it("detects usable history from the current branch without serializing it", () => {
    const session = collectCaptureSession(makeContext([
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Investigate wiki capture flow" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Drafted an implementation outline",
        },
      },
      {
        type: "tool_call",
        toolName: "wiki_briefing",
        args: { topic: "capture" },
      },
      {
        type: "tool_result",
        toolName: "wiki_briefing",
        result: { ok: true },
      },
    ] as any[]));

    expect(session).toEqual({ branchId: "session-1" });
  });

  it("returns null when the branch has no usable history", () => {
    expect(collectCaptureSession(makeContext([] as any[]))).toBeNull();
  });
});

describe("wiki capture directive", () => {
  it("builds a staging directive that instructs pending patch creation", () => {
    const directive = buildWikiCaptureDirective({
      mode: "stage",
      session: { branchId: "branch-1" },
    });

    expect(directive).toContain("Fleet Wiki capture staging");
    expect(directive).toContain("call `wiki_ingest`");
    expect(directive).toContain("Do not approve, merge, or otherwise finalize any patch");
    expect(directive).toContain("Report the staged patch IDs");
  });

  it("builds an approval-gated preview directive", () => {
    const directive = buildWikiCaptureDirective({
      mode: "preview",
      session: { branchId: "branch-1" },
    });

    expect(directive).toContain("Fleet Wiki capture preview");
    expect(directive).toContain("Do not call `wiki_ingest`");
    expect(directive).toContain("candidate wiki entries");
    expect(directive).toContain("Base the preview on the current conversation/session history");
    expect(directive).toContain("branch `branch-1`");
    expect(directive).not.toContain("<fleet_wiki_capture_source>");
  });
});

describe("wiki hub command registration", () => {
  it("registers fleet:wiki:menu as the single command entrypoint", () => {
    const registerCommand = vi.fn();
    registerWikiCommands({ registerCommand, sendUserMessage: vi.fn() } as any);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith("fleet:wiki:menu", expect.objectContaining({
      description: "Fleet Wiki 인터랙티브 허브",
    }));
  });
});

describe("runCapture", () => {
  it("dispatches a follow-up staging turn by default choice", async () => {
    const notify = vi.fn();
    const select = vi.fn().mockResolvedValue("의미 있는 지식 staging");
    const ctx = makeContext([
      {
        type: "message",
        message: { role: "user", content: "Please capture this session." },
      },
    ] as any[], { notify, select });

    const pi = { sendUserMessage: vi.fn() } as any;
    await runCapture(pi, ctx);

    expect(select).toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Fleet Wiki capture staging"), {
      deliverAs: "followUp",
    });
    expect(notify).toHaveBeenCalledWith("Fleet Wiki capture staging 지시를 Admiral 후속 턴에 전달했습니다.", "info");
  });

  it("keeps preview-only mode available without staging patches immediately", async () => {
    const notify = vi.fn();
    const select = vi.fn().mockResolvedValue("프리뷰 캡처 계획");
    const ctx = makeContext([
      {
        type: "message",
        message: { role: "user", content: "Please capture this session." },
      },
    ] as any[], { notify, select });

    const pi = { sendUserMessage: vi.fn() } as any;
    await runCapture(pi, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Fleet Wiki capture preview"), {
      deliverAs: "followUp",
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.not.stringContaining("Stage actual pending Fleet Wiki patches"), {
      deliverAs: "followUp",
    });
  });

  it("does not dispatch when history is unavailable", async () => {
    const notify = vi.fn();
    const select = vi.fn();
    const ctx = makeContext([] as any[], { notify, select });

    const pi = { sendUserMessage: vi.fn() } as any;
    await runCapture(pi, ctx);

    expect(select).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("현재 세션에서 캡처할 대화/작업 이력이 없어 Fleet Wiki preview를 시작할 수 없습니다.", "warning");
  });
});

function makeContext(
  branchEvents: any[],
  overrides: {
    notify?: ReturnType<typeof vi.fn>;
    select?: ReturnType<typeof vi.fn>;
  } = {},
): any {
  const branch = [...branchEvents];
  (branch as any).id = "branch-1";
  return {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-1",
    },
    ui: {
      notify: overrides.notify ?? vi.fn(),
      select: overrides.select ?? vi.fn(),
    },
  };
}
