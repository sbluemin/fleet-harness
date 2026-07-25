import { describe, expect, it } from "vitest";

import { getT, TERMINAL_MESSAGES, translateServerMessage } from "../i18n/index.js";

describe("terminal message catalog", () => {
  it("keeps complete English and Korean key pairs with approved placeholders", () => {
    expect(Object.keys(TERMINAL_MESSAGES.en)).toEqual(Object.keys(TERMINAL_MESSAGES.ko));
    const t = getT("ko");
    expect(t("terminal.analyst.artifactPublished", { title: "세션 브리프" })).toBe("아티팩트 발행됨 — 세션 브리프");
    expect(t("terminal.analyst.cancelQueued", { "index + 1": 2 })).toBe("대기 중인 질문 2 취소");
    expect(t("terminal.artifacts.showCount_other", { count: 3 })).toBe("아티팩트 보기(3개)");
    expect(getT("en")("terminal.artifacts.hideCount_one", { count: 1 })).toBe("Hide artifacts (1 item)");
    expect(getT("en")("terminal.artifacts.hideCount_other", { count: 3 })).toBe("Hide artifacts (3 items)");
    for (const key of Object.keys(TERMINAL_MESSAGES.en) as Array<keyof typeof TERMINAL_MESSAGES.en>) {
      const placeholders = (value: string) => [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(TERMINAL_MESSAGES.ko[key])).toEqual(placeholders(TERMINAL_MESSAGES.en[key]));
    }
  });

  it("uses the host-confirmed Korean labels for send-related copy", () => {
    expect(TERMINAL_MESSAGES.ko["terminal.analyst.send"]).toBe("보내기");
    expect(TERMINAL_MESSAGES.ko["terminal.analyst.sendMessageFirst"]).toContain("메시지를");
    expect(TERMINAL_MESSAGES.ko["terminal.analysis.error.sessionEnded"]).toContain("재시작합니다");
  });

  it("does not reinterpret placeholder-like text inside replacements", () => {
    expect(getT("en")("terminal.analyst.activity.usingTool", {
      title: "tool {status}",
      status: "RUNNING",
    })).toBe("Using tool {status}");
  });

  it("translates known server error strings at display time", () => {
    expect(translateServerMessage("ko", "Analysis session was not found.")).toBe("분석 세션을 찾을 수 없습니다.");
    expect(translateServerMessage("ko", "Analysis request failed.")).toBe("분석 요청이 실패했습니다.");
    expect(translateServerMessage("en", "Stop failed: boom")).toBe("Stop failed: boom");
    expect(translateServerMessage("ko", "Stop failed: boom")).toBe("중지 실패: boom");
  });
});
