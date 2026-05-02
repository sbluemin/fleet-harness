import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindCarrierJobStreamPi,
  handleCarrierJobStreamEvent,
  resetPanelStateForTest,
} from "../../../src/agent/ui/panel/state.js";

beforeEach(() => {
  resetPanelStateForTest();
  bindCarrierJobStreamPi(null);
});

describe("handleCarrierJobStreamEvent job:finalized", () => {
  it("forwards systemReminder payloads through pi.sendMessage", () => {
    const pi = { sendMessage: vi.fn() };
    bindCarrierJobStreamPi(pi as any);

    handleCarrierJobStreamEvent({
      type: "job:finalized",
      jobId: "sortie:1",
      status: "done",
      finishedAt: 2,
      summary: "done",
      systemReminder: '<system-reminder source="carrier-completion">\n[carrier:result]\n- sortie:1: done\n</system-reminder>',
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "carrier-result",
        content: '<system-reminder source="carrier-completion">\n[carrier:result]\n- sortie:1: done\n</system-reminder>',
        display: false,
        details: {
          jobIds: ["sortie:1"],
          summaries: ["done"],
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("does not push when systemReminder is absent", () => {
    const pi = { sendMessage: vi.fn() };
    bindCarrierJobStreamPi(pi as any);

    handleCarrierJobStreamEvent({
      type: "job:finalized",
      jobId: "sortie:1",
      status: "done",
      finishedAt: 2,
      summary: "done",
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
