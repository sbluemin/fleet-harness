import { describe, it, expect } from "vitest";
import { ko } from "../client/src/i18n/messages/ko";
import { en } from "../client/src/i18n/messages/en";
import { flattenKeys, validateKeysets } from "../client/src/i18n/t";

describe("dictionary keyset parity", () => {
  it("ko and en have identical flattened keysets", () => {
    const { valid, missingInEn, missingInKo } = validateKeysets();
    expect(missingInEn).toEqual([]);
    expect(missingInKo).toEqual([]);
    expect(valid).toBe(true);
  });

  it("ko has at least 50 keys", () => {
    expect(flattenKeys(ko).length).toBeGreaterThanOrEqual(50);
  });

  it("en has exactly the same number of keys as ko", () => {
    expect(flattenKeys(en).length).toBe(flattenKeys(ko).length);
  });
});

describe("brand vocabulary invariant in dictionaries", () => {
  const brandTerms = [
    "Constellation",
    "Drydock",
    "Codex",
    "Maritime Codex",
    "Manifest · Raw Source",
    "MANIFEST · CODEX",
    "MANIFEST · PATCH",
    "MANIFEST · DRYDOCK",
    "Fleet · Codex",
  ];

  it("brand terms in ko match en where present", () => {
    const koFlat = Object.fromEntries(
      flattenKeys(ko).map((k) => [k, getNestedValue(ko, k)]),
    );
    const enFlat = Object.fromEntries(
      flattenKeys(en).map((k) => [k, getNestedValue(en, k)]),
    );

    for (const term of brandTerms) {
      const koKeys = Object.entries(koFlat).filter(([, v]) => typeof v === "string" && (v as string).includes(term));
      const enKeys = Object.entries(enFlat).filter(([, v]) => typeof v === "string" && (v as string).includes(term));
      for (const [k] of koKeys) {
        expect(enFlat[k], `en dictionary must also contain "${term}" in key "${k}"`).toBeDefined();
        expect(enFlat[k], `"${term}" must not be translated in en key "${k}"`).toContain(term);
      }
      for (const [k] of enKeys) {
        expect(koFlat[k], `ko dictionary must also contain "${term}" in key "${k}"`).toBeDefined();
        expect(koFlat[k], `"${term}" must not be translated in ko key "${k}"`).toContain(term);
      }
    }
  });
});

describe("missing key fallback", () => {
  it("t() returns key string for unknown keys", async () => {
    const { t } = await import("../client/src/i18n/t");
    expect(t("nonexistent.key.path")).toBe("nonexistent.key.path");
  });

  it("t() resolves known keys without throwing", async () => {
    const { t } = await import("../client/src/i18n/t");
    expect(() => t("common.none")).not.toThrow();
    expect(() => t("nav.searchLabel")).not.toThrow();
  });

  it("t() substitutes template params", async () => {
    const { t } = await import("../client/src/i18n/t");
    const { setLanguage } = await import("../client/src/i18n/store");
    setLanguage("ko");
    const result = t("time.minutesAgo", { n: 5 });
    expect(result).toContain("5");
  });
});

function getNestedValue(obj: object, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
