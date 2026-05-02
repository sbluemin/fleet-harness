import { describe, expect, it } from "vitest";
import {
  hashSystemPrompt,
  buildProviderId,
  isFleetProviderId,
  parseProviderId,
  listProviders,
} from "../../src/admiral/agent/models.js";

describe("admiral.agent.models", () => {
  describe("hashSystemPrompt()", () => {
    it("빈 문자열은 빈 문자열을 반환한다", () => {
      expect(hashSystemPrompt("")).toBe("");
    });

    it("undefined는 빈 문자열을 반환한다", () => {
      expect(hashSystemPrompt(undefined)).toBe("");
    });

    it("동일한 입력은 동일한 해시를 반환한다 (결정론적)", () => {
      const prompt = "You are a helpful assistant.";
      const h1 = hashSystemPrompt(prompt);
      const h2 = hashSystemPrompt(prompt);
      expect(h1).toBe(h2);
    });

    it("다른 입력은 다른 해시를 반환한다", () => {
      const h1 = hashSystemPrompt("prompt A");
      const h2 = hashSystemPrompt("prompt B");
      expect(h1).not.toBe(h2);
    });

    it("해시는 base-36 문자열이다", () => {
      const hash = hashSystemPrompt("test prompt");
      expect(hash).toMatch(/^[0-9a-z]+$/);
    });

    it("긴 프롬프트도 정상 해시한다", () => {
      const longPrompt = "A".repeat(10000);
      const hash = hashSystemPrompt(longPrompt);
      expect(hash).toBeTruthy();
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("buildProviderId()", () => {
    it("등록된 CLI 타입에 대해 provider ID를 반환한다", () => {
      const providers = listProviders();
      if (providers.length === 0) return;
      const first = providers[0]!;
      expect(buildProviderId(first.cli)).toBe(first.providerId);
    });
  });

  describe("isFleetProviderId() / parseProviderId()", () => {
    it("등록된 provider ID는 fleet provider로 인식된다", () => {
      const providers = listProviders();
      if (providers.length === 0) return;
      const first = providers[0]!;
      expect(isFleetProviderId(first.providerId)).toBe(true);
    });

    it("등록되지 않은 provider ID는 fleet provider가 아니다", () => {
      expect(isFleetProviderId("nonexistent-provider")).toBe(false);
    });

    it("parseProviderId는 등록된 provider ID에 대해 CliType을 반환한다", () => {
      const providers = listProviders();
      if (providers.length === 0) return;
      const first = providers[0]!;
      expect(parseProviderId(first.providerId)).toBe(first.cli);
    });

    it("parseProviderId는 미등록 provider ID에 대해 null을 반환한다", () => {
      expect(parseProviderId("nonexistent")).toBeNull();
    });
  });

  describe("listProviders()", () => {
    it("하나 이상의 provider를 반환한다", () => {
      const providers = listProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });

    it("각 provider는 필수 필드를 포함한다", () => {
      const providers = listProviders();
      for (const p of providers) {
        expect(p.cli).toBeTruthy();
        expect(p.providerId).toBeTruthy();
        expect(p.displayName).toBeTruthy();
        expect(p.modelCount).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
