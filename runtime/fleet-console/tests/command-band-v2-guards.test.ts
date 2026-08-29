// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { OperationCatalogPlugin } from "../sdk/operations/types.js";

import { commandBandActiveOperation, commandBandCenterFits, commandBandCenterGutter, commandBandLaunchModelLabels, commandBandMapControlsAnchor, commandBandMenuClampedLeft, commandBandOperationAttribute, commandBandRenameCommitTarget, commandBandSwitcherFocusLeft, commandBandTheaterOperations } from "../core/client/src/components/command-band-guards.js";
import type { OperationGroup, OperationNode } from "../core/client/src/types.js";

describe("Command Band v2 guards", () => {
  it("does not commit a previous Operation draft after another panel becomes active", () => {
    const draft = "previous-operation draft";
    const capturedOperationId = "operation-a";
    const activeOperationId = "operation-b";

    expect(draft).toBe("previous-operation draft");
    expect(commandBandRenameCommitTarget(capturedOperationId, activeOperationId)).toBeNull();
  });

  it("disables Fit all panels until Operations hydrate", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");

    // Fit all은 Cruise 트레이에만 마운트되므로 모드 게이트는 더 이상 필요 없다 — hydrate 게이트만 남는다.
    expect(source).toContain("disabled={state.activeTheaterId === null || !state.operationsHydrated}");
    expect(source).not.toContain("|| triageActive ||");
  });
});

describe("Command Band active Operation display guard", () => {
  const operations: readonly OperationNode[] = [
    makeOperation("op-a", "theater-a"),
    makeOperation("op-b", "theater-b"),
  ];

  it("returns the active Operation when it belongs to the active Theater", () => {
    expect(commandBandActiveOperation(operations, "op-a", "theater-a")?.id).toBe("op-a");
  });

  it("hides a stale Operation after switching to another Theater", () => {
    // setActiveTheater는 activeOperationId를 지우지 않는다 — 타 Theater op는 표시하지 않는다.
    expect(commandBandActiveOperation(operations, "op-b", "theater-a")).toBeNull();
  });

  it("returns null without an active Theater or Operation", () => {
    expect(commandBandActiveOperation(operations, null, "theater-a")).toBeNull();
    expect(commandBandActiveOperation(operations, "op-a", null)).toBeNull();
    expect(commandBandActiveOperation(operations, "op-gone", "theater-a")).toBeNull();
  });
});

describe("Command Band rename cancel follows the displayed Operation", () => {
  const operations: readonly OperationNode[] = [makeOperation("op-a", "theater-a")];

  it("keeps the draft while the captured Operation is still displayed", () => {
    const displayed = commandBandActiveOperation(operations, "op-a", "theater-a");
    expect(commandBandRenameCommitTarget("op-a", displayed?.id ?? null)).toBe("op-a");
  });

  it("drops the draft when a Theater switch hides the captured Operation even though activeOperationId is unchanged", () => {
    // setActiveTheater는 activeOperationId를 유지한다 — 표시 대상(P0 가드) 기준으로는 어긋나야 취소된다.
    const displayed = commandBandActiveOperation(operations, "op-a", "theater-b");
    expect(displayed).toBeNull();
    expect(commandBandRenameCommitTarget("op-a", displayed?.id ?? null)).toBeNull();
  });
});

describe("Command Band switcher disclosure", () => {
  it("keeps the Theater and Operation carets visible without hover", () => {
    const styles = readFileSync(resolve(process.cwd(), "core/client/src/styles/layout.css"), "utf8");
    const caretRule = styles.match(/\.command-band-trigger-caret \{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(caretRule).toContain("opacity: 0.75");
    expect(styles).not.toContain(".command-band-segment-trigger:hover .command-band-trigger-caret");
  });

  it("places the activity status mark on the Operation name and drops the provider glyph and model chip", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");
    const styles = readFileSync(resolve(process.cwd(), "core/client/src/styles/layout.css"), "utf8");

    // 이름 왼쪽 슬롯은 활동 상태가 소유한다 — 공급자 글리프는 이 표면에서 물러났다.
    // 사이드바 칩·지도 점과 같은 마크 축을 읽어야 한다: raw 활동만 보면 War Room이 무대에 올린 도착
    // 항목을 목록은 도착이라 하고 밴드만 유휴라 부르고(무대 승격이 acknowledged: false로 확인을
    // 미룬다), 섹션 축을 그대로 쓰면 안 본 채 끝난 것이 진짜 대기와 같은 파랑으로 서 버린다.
    expect(source).toContain("resolveOperationMarkVisual({");
    expect(source).not.toContain("resolveOperationDisplayActivity");
    expect(source).toContain("activity: resolveOperationActivity(activeOperation, state.operationRuntime),");
    expect(source).toContain("idleArrivalIds,");
    expect(source).toContain("{activeOperationStatusMark}");
    // Shell만 예외다 — 활동 축을 발행하지 않으므로 그 칸을 종류 글리프가 가져간다. 분기는 밴드가
    // 직접 적지 않고 칩·모바일과 같은 한 문(OperationNameMark)을 지난다.
    expect(source).toContain("<OperationNameMark");
    expect(source).toContain("operation={activeOperation}");
    expect(source).not.toMatch(/command-band[^\n]*type === "shell"/);
    expect(source).not.toContain("operation-provider-mark");
    expect(source).not.toContain("command-band-operation-attribute");
    expect(styles).not.toContain(".command-band-operation-attribute");
    expect(styles).not.toContain(".command-band-operation-kind");
    expect(styles).toContain(".command-band-operation-status");
  });
});

describe("Command Band switcher focusout close decision", () => {
  it("stays open while focus moves within the wrapper and closes when it leaves or vanishes", () => {
    const wrapper = document.createElement("div");
    const inside = document.createElement("button");
    wrapper.append(inside);
    const outside = document.createElement("button");
    document.body.append(wrapper, outside);

    expect(commandBandSwitcherFocusLeft(wrapper, inside)).toBe(false);
    expect(commandBandSwitcherFocusLeft(wrapper, outside)).toBe(true);
    // relatedTarget null = 창 블러/비포커서블 클릭 — 메뉴를 남기지 않는다.
    expect(commandBandSwitcherFocusLeft(wrapper, null)).toBe(true);

    wrapper.remove();
    outside.remove();
  });
});

describe("Command Band menu viewport clamp", () => {
  it("keeps the desired left when the menu already fits", () => {
    expect(commandBandMenuClampedLeft(40, 300, 236, 1440)).toBe(40);
  });

  it("pulls an overflowing menu inside the right gutter (sentinel 480px measurements)", () => {
    // Theater 메뉴: wrapper left 292, width 236 → viewport 우측 468(=480-12)에 정렬.
    expect(commandBandMenuClampedLeft(0, 292, 236, 480)).toBe(-60);
    expect(292 + commandBandMenuClampedLeft(0, 292, 236, 480) + 236).toBe(480 - 12);
    // Operation 메뉴: 트리거 offsetLeft 98(viewport 390), width 274 → right 664가 468로 당겨진다.
    expect(292 + commandBandMenuClampedLeft(98, 292, 274, 480) + 274).toBe(480 - 12);
  });

  it("prioritizes the left gutter when the menu is wider than the viewport", () => {
    expect(commandBandMenuClampedLeft(0, 20, 500, 480)).toBe(12 - 20);
  });
});

describe("Command Band center visibility measurements", () => {
  it("uses the floor gutter while map controls are unmeasured or narrower than the floor", () => {
    expect(commandBandCenterGutter(0, 0)).toBe(44);
    expect(commandBandCenterGutter(0, 1)).toBe(44);
  });

  it("derives the gutter from the map controls' viewport edge", () => {
    expect(commandBandCenterGutter(0, 163)).toBe(8 + 163 + 12);
    // 펼친 사이드바 경계도 viewport 좌표 그대로 포함한다 — 브레드크럼 중심은 Console 중앙이다.
    expect(commandBandCenterGutter(280, 163)).toBe(280 + 8 + 163 + 12);
    // 접힘 시에는 좌측 컨트롤군 끝으로 도킹한 앵커가 같은 좌표계에서 하한을 정한다.
    expect(commandBandCenterGutter(185, 163)).toBe(185 + 8 + 163 + 12);
  });

  it("docks the map controls to the measured left-cluster end only while collapsed", () => {
    // 펼침: 앵커 = 사이드바 폭(경계선 옆) — 기존 문법 그대로.
    expect(commandBandMapControlsAnchor(false, 280, 183)).toBe(280);
    // 접힘: 앵커 = 콘텐츠 끝. CSS 인셋(8)이 펼침 상태와 같은 단일 간격을 만든다.
    expect(commandBandMapControlsAnchor(true, 280, 183)).toBe(183);
    // 사이드바를 넓혀도 접힘 앵커는 사이드바 폭과 무관하다 — 넓힌-뒤-접기 부유가 소멸한다.
    expect(commandBandMapControlsAnchor(true, 460, 183)).toBe(183);
    // 미측정(0 이하) 폴백: 기존 사이드바 폭 앵커를 유지해 첫 페인트가 흔들리지 않는다.
    expect(commandBandMapControlsAnchor(true, 280, 0)).toBe(280);
  });

  it("keeps the center visible while the track is unmeasured", () => {
    expect(commandBandCenterFits(0, 183)).toBe(true);
    expect(commandBandCenterFits(-1, 183)).toBe(true);
  });

  it("requires the two gutters plus the minimum readable center width", () => {
    const gutter = 183;
    expect(commandBandCenterFits(gutter * 2 + 168, gutter)).toBe(true);
    expect(commandBandCenterFits(gutter * 2 + 168 - 1, gutter)).toBe(false);
  });
});

describe("Command Band operation menu ordering", () => {
  const grouped = (id: string, theaterId: string, groupId: string | null): OperationNode => ({
    ...makeOperation(id, theaterId),
    ...(groupId !== null ? { groupId } : {}),
  });
  const makeGroup = (id: string, theaterId: string, order: number): OperationGroup => ({
    id,
    theaterId,
    name: id,
    color: "crimson",
    order,
    createdAt: order,
  });

  it("mirrors the grouped sidebar order, not the flat operationOrder", () => {
    // flat 순서상 g2 소속 op-b가 앞서지만, 사이드바는 그룹 순서(g1 먼저)로 평탄화한다.
    const operations = [grouped("op-b", "t1", "g2"), grouped("op-a", "t1", "g1"), grouped("op-c", "t1", null)];
    const groups = [makeGroup("g1", "t1", 0), makeGroup("g2", "t1", 1)];
    const ids = commandBandTheaterOperations(operations, groups, "t1", ["op-b", "op-a", "op-c"]).map((op) => op.id);
    expect(ids).toEqual(["op-a", "op-b", "op-c"]);
  });

  it("keeps every active-theater operation reachable and excludes other theaters", () => {
    const operations = [grouped("op-a", "t1", "g1"), grouped("op-x", "t2", null)];
    const groups = [makeGroup("g1", "t1", 0), makeGroup("g9", "t2", 0)];
    const ids = commandBandTheaterOperations(operations, groups, "t1", []).map((op) => op.id);
    expect(ids).toEqual(["op-a"]);
  });
});

describe("Command Band Operation attribute", () => {
  // 실행 카탈로그가 내놓는 모양 그대로다: 네이티브 Claude 그룹과 공급자별 게이트웨이 그룹.
  // 게이트웨이 행 라벨은 models.json의 `name`(provider 접두를 벗긴 소재 이름)이다.
  const catalog: readonly OperationCatalogPlugin[] = [
    {
      id: "terminal",
      title: "Terminal",
      kinds: [
        { id: "claude", type: "agent", title: "Claude Code" },
        {
          id: "claude",
          type: "agent",
          title: "Claude",
          variants: [
            {
              id: "native",
              label: "Claude",
              rows: [{ id: "opus[1m]", label: "Opus", launch: { model: "opus[1m]" } }],
            },
            {
              id: "gateway:codex",
              label: "Codex",
              rows: [{ id: "codex--gpt-5.6-sol-fast", label: "GPT-5.6-Sol-Fast", launch: { model: "codex--gpt-5.6-sol-fast" } }],
            },
          ],
        },
      ],
    },
  ];
  const labels = commandBandLaunchModelLabels(catalog);

  it("indexes every launch row by its model coordinate", () => {
    expect(labels.get("codex--gpt-5.6-sol-fast")).toBe("GPT-5.6-Sol-Fast");
    expect(labels.get("opus[1m]")).toBe("Opus");
    expect(labels.size).toBe(2);
  });

  it("names the model that is actually running instead of the CLI", () => {
    expect(commandBandOperationAttribute(
      { session: { harness: "claude-code", model: "codex--gpt-5.6-sol-fast" } },
      labels,
    )).toBe("GPT-5.6-Sol-Fast");
    expect(commandBandOperationAttribute(
      { session: { harness: "claude-code", model: "opus[1m]" } },
      labels,
    )).toBe("Opus");
  });

  it("falls back to the harness label when the coordinate is missing or unknown", () => {
    expect(commandBandOperationAttribute({ session: { harness: "claude-code" } }, labels))
      .toBe("Claude Code");
    expect(commandBandOperationAttribute(
      { session: { harness: "claude-code", model: "kimi--k3" } },
      labels,
    )).toBe("Claude Code");
    expect(commandBandOperationAttribute({}, labels)).toBeNull();
  });

  it("reads an empty index before the catalog arrives", () => {
    expect(commandBandLaunchModelLabels([]).size).toBe(0);
    expect(commandBandOperationAttribute(
      { session: { harness: "claude-code", model: "codex--gpt-5.6-sol-fast" } },
      commandBandLaunchModelLabels([]),
    )).toBe("Claude Code");
  });
});

function makeOperation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
