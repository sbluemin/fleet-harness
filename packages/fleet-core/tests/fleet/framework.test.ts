/**
 * framework.test.ts — Carrier 프레임워크 registerCarrier 검증
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCarrier,
  clearRegisteredCarriers,
  getRegisteredOrder,
} from "../../src/admiral/carrier/framework.js";
import {
  RESERVED_CARRIER_IDS,
  CARRIER_ID_FORMAT_REGEX,
} from "../../src/admiral/carrier/types.js";
import type { CarrierConfig } from "../../src/admiral/carrier/types.js";

// ─────────────────────────────────────────────────────────
// 테스트 픽스처
// ─────────────────────────────────────────────────────────

function makeConfig(id: string): CarrierConfig {
  return {
    id,
    cliType: "codex" as import("@sbluemin/fleet-unified-agent").CliType,
    defaultCliType: "codex" as import("@sbluemin/fleet-unified-agent").CliType,
    slot: 1,
    displayName: id,
    color: "",
  };
}

// ─────────────────────────────────────────────────────────
// registerCarrier ID 검증
// ─────────────────────────────────────────────────────────

describe("registerCarrier ID 검증", () => {
  beforeEach(() => {
    clearRegisteredCarriers();
  });

  it("예약 ID 등록 시 throw", () => {
    for (const reservedId of RESERVED_CARRIER_IDS) {
      clearRegisteredCarriers();
      expect(() => registerCarrier(makeConfig(reservedId))).toThrow(
        `Reserved carrier ID "${reservedId}" is not allowed.`,
      );
    }
  });

  it("잘못된 형식의 ID 등록 시 throw", () => {
    const invalidIds = ["Foo", "1abc", "my-carrier", "carrier:id", ""];
    for (const id of invalidIds) {
      clearRegisteredCarriers();
      expect(() => registerCarrier(makeConfig(id))).toThrow(
        new RegExp(`Invalid carrier ID "${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      );
    }
  });

  it("유효한 ID는 정상 등록", () => {
    const validIds = ["genesis", "my_carrier_2", "a", "abc123"];
    for (const id of validIds) {
      clearRegisteredCarriers();
      registerCarrier(makeConfig(id));
      expect(getRegisteredOrder()).toContain(id);
    }
  });

  it("기존 8개 빌트인 캐리어 ID는 모두 유효", () => {
    const builtInIds = ["nimitz", "kirov", "genesis", "ohio", "sentinel", "vanguard", "tempest", "chronicle"];
    for (const id of builtInIds) {
      clearRegisteredCarriers();
      registerCarrier(makeConfig(id));
      expect(getRegisteredOrder()).toContain(id);
    }
  });
});

// ─────────────────────────────────────────────────────────
// CARRIER_ID_FORMAT_REGEX
// ─────────────────────────────────────────────────────────

describe("CARRIER_ID_FORMAT_REGEX", () => {
  it("유효한 ID 매칭", () => {
    expect(CARRIER_ID_FORMAT_REGEX.test("genesis")).toBe(true);
    expect(CARRIER_ID_FORMAT_REGEX.test("a")).toBe(true);
    expect(CARRIER_ID_FORMAT_REGEX.test("my_carrier_2")).toBe(true);
  });

  it("유효하지 않은 ID 미매칭", () => {
    expect(CARRIER_ID_FORMAT_REGEX.test("Foo")).toBe(false);
    expect(CARRIER_ID_FORMAT_REGEX.test("1abc")).toBe(false);
    expect(CARRIER_ID_FORMAT_REGEX.test("my-carrier")).toBe(false);
    expect(CARRIER_ID_FORMAT_REGEX.test("carrier:id")).toBe(false);
    expect(CARRIER_ID_FORMAT_REGEX.test("")).toBe(false);
  });
});
