import { describe, expect, it } from "vitest";

import { quotaEn, quotaKo } from "../client/i18n/messages.js";

describe("quota translations", () => {
  it("keeps English and Korean keys and placeholders in parity", () => {
    expect(Object.keys(quotaKo)).toEqual(Object.keys(quotaEn));
    for (const key of Object.keys(quotaEn) as Array<keyof typeof quotaEn>) {
      const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(quotaKo[key]), key).toEqual(placeholders(quotaEn[key]));
    }
  });
});
