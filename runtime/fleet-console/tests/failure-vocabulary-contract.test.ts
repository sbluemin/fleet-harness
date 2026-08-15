import { describe, expect, it } from "vitest";

import { describeTheaterFolderFailure } from "../core/client/src/failure-notices.js";
import { CORE_MESSAGES, getT } from "../core/client/src/i18n/index.js";

/**
 * 실패 화법 계약.
 *
 * 사용자에게 도달하는 실패는 무슨 일(title) · 왜와 지금 할 일(cause) 세 조각을 갖는다.
 * 이 파일은 그 형태를 문구 수준에서 고정한다 — 새 실패 문구가 상태만 알리고 할 일을 빼면
 * 여기서 걸린다. 코드→문장 매핑 자체는 그 코드를 아는 쪽의 테스트가 지킨다.
 */
describe("failure vocabulary contract", () => {
  const locales = ["en", "ko"] as const;

  function failureKeys(locale: "en" | "ko"): readonly string[] {
    return Object.keys(CORE_MESSAGES[locale]).filter((key) => key.startsWith("chrome.failure."));
  }

  it("pairs every failure title with a cause, in both locales", () => {
    for (const locale of locales) {
      const keys = failureKeys(locale);
      expect(keys.length, locale).toBeGreaterThan(0);
      const titles = keys.filter((key) => key.endsWith(".title"));
      for (const title of titles) {
        const cause = `${title.slice(0, -".title".length)}.cause`;
        // 제목만 있고 원인이 없으면 화면은 무슨 일이 있었는지까지만 말하고 멈춘다.
        expect(keys, `${locale} ${title}`).toContain(cause);
      }
      // 반대 방향도 막는다 — 원인만 있고 제목이 없는 조각은 어디에도 붙지 못한다.
      for (const cause of keys.filter((key) => key.endsWith(".cause"))) {
        expect(keys, `${locale} ${cause}`).toContain(`${cause.slice(0, -".cause".length)}.title`);
      }
    }
  });

  it("never leaves a failure sentence empty or untranslated", () => {
    for (const locale of locales) {
      const t = getT(locale);
      for (const key of failureKeys(locale)) {
        const text = t(key as Parameters<typeof t>[0]);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(4);
      }
    }
    // 두 로케일이 같은 문자열이면 한쪽이 번역되지 않은 것이다 — 고유명사만 남는 짧은 라벨과
    // 달리 실패 문장은 서술문이라 우연히 같아질 수 없다.
    for (const key of failureKeys("en")) {
      expect(getT("en")(key as never), key).not.toBe(getT("ko")(key as never));
    }
  });

  it("gives an unknown code a sentence rather than the code itself", () => {
    const notice = describeTheaterFolderFailure("a_code_no_one_has_mapped", getT("en"));
    expect(notice.title).not.toContain("a_code_no_one_has_mapped");
    expect(notice.cause).not.toContain("a_code_no_one_has_mapped");
    // 기계 코드는 사라지지 않는다 — 문장 자리를 비켜 진단으로 남아 지원 문의에 쓰인다.
    expect(notice.diagnostic).toBe("a_code_no_one_has_mapped");
  });

  it("keeps machine codes out of every failure sentence", () => {
    for (const locale of locales) {
      const t = getT(locale);
      for (const key of failureKeys(locale)) {
        const text = t(key as never);
        // snake_case 토큰은 기계 코드의 형태다. 문장에 섞이면 예전 화법으로 되돌아간 것이다.
        expect(text, `${locale} ${key}`).not.toMatch(/\b[a-z]+_[a-z_]+\b/u);
      }
    }
  });
});
