import { describe, expect, it } from "vitest";

import { ANALYSIS_COPY, analysisCopy } from "./analysis-i18n.js";

describe("Session Analyst copy table", () => {
  it("keeps complete English and Korean key pairs with approved placeholders", () => {
    expect(Object.keys(ANALYSIS_COPY.en)).toEqual(Object.keys(ANALYSIS_COPY.ko));
    expect(analysisCopy("ko", "Artifact published — {title}", { title: "세션 브리프" })).toBe("아티팩트 발행됨 — 세션 브리프");
    expect(analysisCopy("ko", "Cancel queued question {index + 1}", { "index + 1": 2 })).toBe("대기 중인 질문 2 취소");
    expect(analysisCopy("ko", "Show artifacts ({count} {item/items})", { count: 3, "item/items": "items" })).toBe("아티팩트 보기(3개)");
  });

  it("uses the host-confirmed Korean labels for send-related copy", () => {
    expect(ANALYSIS_COPY.ko["Send"]).toBe("보내기");
    expect(ANALYSIS_COPY.ko["Send a message in this session first"]).toContain("메시지를");
    expect(ANALYSIS_COPY.ko["Analysis session ended — send again to restart."]).toContain("재시작합니다");
  });

  it("does not reinterpret placeholder-like text inside replacements", () => {
    expect(analysisCopy("en", "Using {title}", {
      title: "tool {status}",
      status: "RUNNING",
    })).toBe("Using tool {status}");
  });
});
