import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHAT_READING_WIDTH,
  isChatReadingWidth,
  nextChatReadingWidth,
} from "../client/shared/terminal-preferences.js";

describe("chat reading width preference", () => {
  it("defaults to the centered reading column so existing sessions render unchanged", () => {
    expect(DEFAULT_CHAT_READING_WIDTH).toBe("reading");
  });

  it("accepts exactly the three presets and rejects anything else from the settings record", () => {
    expect(isChatReadingWidth("reading")).toBe(true);
    expect(isChatReadingWidth("wide")).toBe(true);
    expect(isChatReadingWidth("full")).toBe(true);
    // 서버 설정 레코드는 자유형 JSON이다 — 여기서 걸러지지 않으면 잘못된 값이 data 속성으로 샌다.
    expect(isChatReadingWidth("Reading")).toBe(false);
    expect(isChatReadingWidth("")).toBe(false);
    expect(isChatReadingWidth(100)).toBe(false);
    expect(isChatReadingWidth(null)).toBe(false);
    expect(isChatReadingWidth(undefined)).toBe(false);
    expect(isChatReadingWidth({ value: "wide" })).toBe(false);
  });

  it("cycles reading → wide → full → reading, matching the chip's advertised order", () => {
    expect(nextChatReadingWidth("reading")).toBe("wide");
    expect(nextChatReadingWidth("wide")).toBe("full");
    expect(nextChatReadingWidth("full")).toBe("reading");
  });
});
