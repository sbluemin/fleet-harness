// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { plugins } from "../client/index.js";

describe("Codex reader addressing", () => {
  // 리더 주소 동기화는 rail 패널 안에 있으면 패널이 닫히는 순간 멈춘다. 실제로 콘솔
  // 페이지에서 호출이 사라진 뒤로 훅이 아무 데서도 마운트되지 않아, 새로고침·공유 링크·
  // 뒤로가기가 전부 죽어 있었다. 상주 기여로 서 있는지 계약 수준에서 못 박는다.
  it("mounts its URL sync as a persistent contribution", () => {
    const codex = plugins.find((plugin) => plugin.id === "codex");
    expect(codex, "the codex plugin is missing").toBeDefined();

    const persistent = codex!.persistentComponents ?? [];
    expect(persistent.map((entry) => entry.id)).toContain("codex-reader-url");
  });

  it("renders nothing, because it exists to run effects and not to paint", () => {
    const codex = plugins.find((plugin) => plugin.id === "codex")!;
    const descriptor = (codex.persistentComponents ?? []).find((entry) => entry.id === "codex-reader-url")!;

    // 요소를 만들되 실행하지는 않는다 — 훅은 호스트가 마운트할 때 돈다.
    expect(descriptor.render()).not.toBeNull();
  });
});
