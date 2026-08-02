import { describe, expect, it } from "vitest";

import {
  beginRequestGeneration,
  EXPIRED_KEY,
  formatCountdown,
  isLatestRequestGeneration,
  NO_SUBSCRIPTION_KEY,
  SIGNED_OUT_KEY,
} from "../client/rail-panel.js";
import { QUOTA_MESSAGES } from "../client/i18n/messages.js";

describe("quota countdown", () => {
  it("formats day, hour, and minute windows", () => {
    const now = 1_000_000;
    expect(formatCountdown(now + 4 * 86_400_000 + 7 * 3_600_000, now)).toBe("4d 7h");
    expect(formatCountdown(now + 4 * 3_600_000 + 23 * 60_000, now)).toBe("4h 23m");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("12m");
  });

  it("prevents an older in-flight request from committing after a newer request starts", () => {
    const generation = { current: 0 };
    const staleRequest = beginRequestGeneration(generation);
    const newestRequest = beginRequestGeneration(generation);
    expect(isLatestRequestGeneration(generation, staleRequest)).toBe(false);
    expect(isLatestRequestGeneration(generation, newestRequest)).toBe(true);
  });
});

describe("provider status copy", () => {
  // 상태 문구는 해당 공급자에서 무엇을 해야 하는지 지시한다. 한 공급자의 안내가 다른
  // 공급자 카드에 뜨면 사용자는 엉뚱한 CLI나 설정 화면으로 보내진다.
  it("names its own provider in every provider-specific message", () => {
    const en = QUOTA_MESSAGES.en;
    const expectedMention: Readonly<Record<string, string>> = {
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      kimi: "Kimi",
    };
    for (const map of [SIGNED_OUT_KEY, EXPIRED_KEY]) {
      for (const [provider, key] of Object.entries(map)) {
        expect(en[key], `${provider} → ${key}`).toContain(expectedMention[provider] ?? provider);
      }
    }
    // Kimi가 공용 문구를 타면 "No active Cursor subscription." 이 뜬다.
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).toContain("Kimi");
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).not.toContain("Cursor");
    expect(en[NO_SUBSCRIPTION_KEY.cursor]).toContain("Cursor");
  });
});
