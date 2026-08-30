import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetPaneStoreForTests,
  getPaneStoreSnapshot,
  openPane,
  resetSurfacePanes,
} from "../core/client/src/pane/pane-store.js";

/**
 * 표면 정리의 도착 면제 계약.
 *
 * 팔레트·딥링크는 표면을 열기 직전에 openPane으로 착지 params를 심는다. RailSurface가
 * 마운트하며 도는 resetSurfacePanes가 그 씨앗까지 쓸면, 문을 연 손짓이 곧 착지를 지운다 —
 * 실측에서 remote-access 딥링크가 겉모습으로 낙하한 결함이 이것이다. 면제는 들어오는
 * 엔트리 소유의 페인에만 서고, keepAlive 주차 계약은 그대로 남는다.
 */
describe("resetSurfacePanes arriving exemption", () => {
  beforeEach(() => {
    __resetPaneStoreForTests();
  });

  it("wipes a seeded instance when no arriving set is given", () => {
    openPane({ paneId: "settings", params: { section: "connectivity" } });
    resetSurfacePanes(new Map());

    expect(getPaneStoreSnapshot().rail).toHaveLength(0);
    expect(getPaneStoreSnapshot().focusedPaneId).toBeNull();
  });

  it("keeps an arriving primary with its params and visibility", () => {
    openPane({ paneId: "settings", params: { section: "connectivity" } });
    resetSurfacePanes(new Map([["settings", { role: "primary" }]]), new Set(["settings"]));

    const [instance] = getPaneStoreSnapshot().rail;
    expect(instance?.paneId).toBe("settings");
    expect(instance?.params).toEqual({ section: "connectivity" });
    expect(instance?.visible).toBe(true);
  });

  it("still parks a keepAlive pane that is not arriving, instead of dropping it", () => {
    openPane({ paneId: "terminal-dock", params: {} });
    resetSurfacePanes(new Map([["terminal-dock", { keepAlive: true }]]), new Set(["settings"]));

    const [instance] = getPaneStoreSnapshot().rail;
    expect(instance?.paneId).toBe("terminal-dock");
    // 주차 — 살아 있되 보이지 않는다. 면제가 keepAlive 계약을 대체하면 안 된다.
    expect(instance?.visible).toBe(false);
  });

  it("drops a non-keepAlive stranger even when an arriving set exists", () => {
    openPane({ paneId: "stray-detail", params: {} });
    resetSurfacePanes(new Map(), new Set(["settings"]));

    expect(getPaneStoreSnapshot().rail).toHaveLength(0);
  });

  it("does not resurrect a closed non-keepAlive detail through the arriving set", () => {
    // 닫힘 동안은 이 정리가 돌지 않는다 — 재열림의 도착 면제가 detail까지 품으면, keepAlive
    // 없이 닫힌 detail이 옛 params째 되살아난다(닫기=언마운트 계약 위반, 리뷰 적발).
    openPane({ paneId: "repo-doc", params: { path: "old.md" } });
    resetSurfacePanes(new Map([["repo-doc", { role: "detail" }]]), new Set(["repo-doc"]));

    expect(getPaneStoreSnapshot().rail).toHaveLength(0);
  });
});
