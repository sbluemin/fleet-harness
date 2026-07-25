import { describe, expect, it } from "vitest";

import { createTranslator, resolveLocalizedText } from "../sdk/i18n/translate.js";
import type { MessageCatalog } from "../sdk/i18n/types.js";
import { formatRelativeTime } from "../core/client/src/i18n/format.js";
import { getT } from "../core/client/src/i18n/index.js";
import { translateServerError } from "../core/client/src/i18n/server-errors.js";

const CATALOG = {
  en: {
    "hello.name": "Hello, {name}!",
    "plain": "Plain",
  },
  ko: {
    "hello.name": "안녕하세요, {name}!",
    "plain": "일반",
  },
} as const satisfies MessageCatalog<"hello.name" | "plain">;

describe("createTranslator", () => {
  it("returns locale-specific values for en and ko", () => {
    expect(createTranslator(CATALOG, "en")("plain")).toBe("Plain");
    expect(createTranslator(CATALOG, "ko")("plain")).toBe("일반");
  });

  it("interpolates {name} placeholders and leaves missing values intact", () => {
    const t = createTranslator(CATALOG, "en");
    expect(t("hello.name", { name: "Fleet" })).toBe("Hello, Fleet!");
    expect(t("hello.name")).toBe("Hello, {name}!");
  });

  it("returns the key itself when the message is missing", () => {
    const t = createTranslator(CATALOG, "en");
    expect(t("missing.key" as "plain")).toBe("missing.key");
  });
});

describe("resolveLocalizedText", () => {
  it("returns strings as-is and invokes locale functions", () => {
    expect(resolveLocalizedText("static", "ko")).toBe("static");
    expect(resolveLocalizedText((locale) => `L:${locale}`, "en")).toBe("L:en");
  });
});

describe("formatRelativeTime", () => {
  it("produces different strings for ko and en", () => {
    const now = Date.UTC(2026, 6, 25, 12, 0, 0);
    const past = now - 90_000;
    const en = formatRelativeTime(past, "en", now);
    const ko = formatRelativeTime(past, "ko", now);
    expect(en).not.toBe(ko);
    expect(en.length).toBeGreaterThan(0);
    expect(ko.length).toBeGreaterThan(0);
  });
});

describe("translateServerError", () => {
  it("maps known English server phrases and preserves unknowns", () => {
    const t = getT("ko");
    expect(translateServerError("Method not allowed", t)).toBe("허용되지 않은 요청 방식입니다");
    expect(translateServerError("Not found", t)).toBe("찾을 수 없습니다");
    expect(translateServerError("Unauthorized", t)).toBe("권한이 없습니다");
    expect(translateServerError("Internal server error", t)).toBe("서버 내부 오류가 발생했습니다");
    expect(translateServerError("Something else", t)).toBe("Something else");
  });
});
