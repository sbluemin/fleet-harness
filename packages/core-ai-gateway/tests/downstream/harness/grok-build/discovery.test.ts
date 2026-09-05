import { describe, expect, it } from "vitest";

import { GATEWAY_MODELS } from "../../../../src/models.js";
import {
  GROK_GATEWAY_MODEL_ALIAS_PREFIX,
  buildGrokModelList,
  findGrokGatewayModel,
  toGrokGatewayModelId,
  toGrokModelSlug,
} from "../../../../src/downstream/harness/grok-build/discovery.js";

describe("grok build model id grammar", () => {
  it("renders every catalog id without a dot", () => {
    for (const model of GATEWAY_MODELS) {
      const id = toGrokGatewayModelId(model);
      expect(id.startsWith(GROK_GATEWAY_MODEL_ALIAS_PREFIX)).toBe(true);
      // TOML의 bare key는 점을 테이블 구분자로 읽는다. 인용을 빠뜨린 `[model.<id>]`가
      // 오류 없이 중첩 테이블이 되는 함정을, 문법에서 점을 없애 지운다.
      expect(id.slice(GROK_GATEWAY_MODEL_ALIAS_PREFIX.length)).not.toContain(".");
    }
  });

  /**
   * 점→대시 사상은 단사여야 한다.
   *
   * 오늘 카탈로그에서 충돌은 0건이지만 그것은 성질이지 불변식이 아니다. 두 카탈로그 항목이
   * 같은 슬러그로 접히면 `findGrokGatewayModel`이 먼저 만난 쪽을 돌려주고, 사용자는 자기가
   * 고르지 않은 공급자의 구독을 쓰게 된다 — 오류 없이. 그 회귀는 여기서만 잡힌다.
   */
  it("maps the whole catalog onto distinct dotless slugs", () => {
    const byslug = new Map<string, string>();
    const collisions: string[] = [];
    for (const model of GATEWAY_MODELS) {
      const slug = toGrokModelSlug(model.id);
      const taken = byslug.get(slug);
      if (taken !== undefined) collisions.push(`${taken} vs ${model.id} -> ${slug}`);
      byslug.set(slug, model.id);
    }
    expect(collisions).toEqual([]);
    expect(byslug.size).toBe(GATEWAY_MODELS.length);
  });

  it("round-trips every advertised id back to its catalog entry", () => {
    for (const model of GATEWAY_MODELS) {
      expect(findGrokGatewayModel(toGrokGatewayModelId(model))?.id).toBe(model.id);
    }
  });

  it("never advertises Claude Code's 1M coordinate marker", () => {
    // Grok Build는 창 크기를 자기 `context_window` 설정에서 읽는다. id에 좌표를 실을 이유가
    // 없고, 실으면 그 표식을 해석하지 못해 모델을 통째로 못 찾는다.
    const oneMillion = GATEWAY_MODELS.filter((model) => (model.contextWindow ?? 0) >= 1_000_000);
    expect(oneMillion.length).toBeGreaterThan(0);
    for (const model of oneMillion) {
      expect(toGrokGatewayModelId(model)).not.toContain("[1m]");
    }
  });

  it("refuses every spelling this harness does not publish", () => {
    // 아래 "점이 살아 있는 형태"가 실제 거부 대상이 되려면 표본 자체가 점을 품어야 한다 —
    // 카탈로그 선두 항목은 점 없는 id일 수 있다(codex--gpt-6-astra).
    const sample = GATEWAY_MODELS.find((model) => model.id.includes("."))!;
    expect(sample).toBeDefined();
    // 접두 없는 카탈로그 고유 id — Claude Code 쪽은 옛 영속 값 때문에 받아 주지만
    // 이 하네스에는 그런 값이 없다.
    expect(findGrokGatewayModel(sample.id)).toBeUndefined();
    // 점이 살아 있는 형태.
    expect(findGrokGatewayModel(`${GROK_GATEWAY_MODEL_ALIAS_PREFIX}${sample.id}`)).toBeUndefined();
    // 다른 하네스의 문법.
    expect(findGrokGatewayModel(`claude-gateway--${sample.id}`)).toBeUndefined();
    // Grok Build가 세션 제목 턴에 싣는 자기 내장 모델 id.
    expect(findGrokGatewayModel("grok-4.6")).toBeUndefined();
  });

  it("answers discovery in the Anthropic list envelope with grok ids", () => {
    const list = buildGrokModelList();
    expect(list.has_more).toBe(false);
    expect(list.data.length).toBe(GATEWAY_MODELS.length);
    expect(list.first_id).toBe(list.data[0]?.id ?? null);
    for (const entry of list.data) {
      expect(entry.type).toBe("model");
      expect(entry.id.startsWith(GROK_GATEWAY_MODEL_ALIAS_PREFIX)).toBe(true);
      expect(entry.display_name).not.toContain("(1M Context)");
    }
    // 창은 봉투가 그대로 싣는다 — 투영이 없으므로 광고값이 곧 공급자의 실제 창이다.
    const luna = list.data.find((entry) => entry.id.endsWith("codex--gpt-5-6-luna"));
    const catalog = GATEWAY_MODELS.find((model) => model.id === "codex--gpt-5.6-luna");
    expect(luna?.max_input_tokens).toBe(catalog?.contextWindow ?? null);
  });
});
