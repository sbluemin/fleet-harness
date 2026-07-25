import { describe, expect, it } from "vitest";

import { getT, TERMINAL_MESSAGES, translateServerMessage } from "../i18n/index.js";

describe("terminal message catalog", () => {
  it("keeps complete English and Korean key pairs with approved placeholders", () => {
    expect(Object.keys(TERMINAL_MESSAGES.en)).toEqual(Object.keys(TERMINAL_MESSAGES.ko));
    const t = getT("ko");
    expect(t("terminal.analyst.artifactPublished", { title: "세션 브리프" })).toBe("아티팩트 발행됨 — 세션 브리프");
    expect(t("terminal.analyst.cancelQueued", { "index + 1": 2 })).toBe("대기 중인 질문 2 취소");
    expect(t("terminal.artifacts.showCount", { count: 3, "item/items": "items" })).toBe("아티팩트 보기(3개)");
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
