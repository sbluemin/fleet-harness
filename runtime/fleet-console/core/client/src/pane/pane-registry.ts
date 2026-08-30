import { useMemo } from "react";

import type { ClientExpandedSurfacesCapability } from "@fleet-console/sdk/plugin";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { usePluginRegistry } from "../plugin-registry.js";
import { BUILT_IN_RAIL_PANELS } from "../rail/built-in-panels.js";

/**
 * 레일 엔트리와 페인의 합성 레지스트리.
 *
 * 옛 `railPanels`와 새 `railEntries`+`panes`가 한동안 함께 산다. 8개 플러그인을 하루에 다
 * 옮길 수는 없고, 옮기는 중간에도 제품은 돌아야 하기 때문이다. 그래서 이 모듈이 옛 서술자를
 * 새 계약으로 **투영**한다 — 플러그인이 한 줄도 바뀌지 않아도 새 렌더러 위에서 그대로 선다.
 *
 * 투영은 손실 없는 방향으로만 한다. 옛 계약이 말하지 않는 것(페인의 role이 detail인지,
 * keepAlive가 필요한지)은 발명하지 않고 가장 보수적인 값으로 둔다. 실제 값은 플러그인이
 * 새 계약으로 옮겨 오면서 스스로 말한다.
 */

/**
 * 호스트가 페인 본문에 실제로 건네는 컨텍스트.
 *
 * 공개 계약(`PaneContext`)에 없는 필드가 셋 붙는다. 전부 옛 `RailPanelContext`가 주던 것으로,
 * 투영된 본문만 읽는다 — 새 계약으로 옮겨 온 페인은 이 필드를 보지 못하는 것이 정상이다.
 * 공개 타입에 넣지 않는 이유가 그것이다: 넣는 순간 옛 결합이 새 계약의 일부가 된다.
 */
export interface HostPaneContext extends PaneContext {
  readonly legacySurfaces?: ClientExpandedSurfacesCapability;
  readonly legacyLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

export interface RailEntryBinding {
  readonly entry: RailEntryDescriptor;
  /** 이 엔트리가 세우는 페인들. 옛 패널에서 투영된 것도 포함한다. */
  readonly panes: readonly PaneDescriptor[];
  /** 옛 `railPanels`에서 투영된 엔트리인가. 폭 저장 키 등 호환 경로가 이 값을 본다. */
  readonly projected: boolean;
  /** 코어가 소유한 기여인가. 합성 순서에서 플러그인보다 앞에 선다. */
  readonly core?: boolean;
}

/**
 * 옛 render형 패널 하나를 엔트리+primary 페인 한 쌍으로 편다.
 *
 * role이 항상 primary인 것은 옛 계약에 열 개념이 없었기 때문이다. 패널 본문이 안에서 스스로
 * 2단을 그리고 있었더라도(Codex·file-explorer가 그랬다) 호스트가 보기에 그것은 여전히 한 열이다.
 * 그 안쪽을 진짜 두 페인으로 가르는 것은 플러그인이 새 계약으로 옮기는 일이지, 투영이 추측할
 * 일이 아니다.
 */
function projectPanel(panel: RailPanelDescriptor, core = false): RailEntryBinding {
  const entry: RailEntryDescriptor = {
    id: panel.id,
    title: panel.title,
    icon: panel.icon,
    side: panel.side,
    ...(panel.activate ? { activate: panel.activate } : { panes: [panel.id] }),
    ...(panel.surfaceId ? { surfaceId: panel.surfaceId } : {}),
  };

  // activate형(Shell)은 펼칠 본문이 없다 — 아이콘이 곧 동작이다.
  if (panel.activate) return { entry, panes: [], projected: true, core };

  const pane: PaneDescriptor = {
    id: panel.id,
    role: "primary",
    mounts: ["rail"],
    title: (ctx) => resolveEntryTitle(panel, ctx.language),
    render: (context) => {
      const ctx = context as HostPaneContext;
      return panel.render?.({
        theaterId: ctx.theaterId,
        api: ctx.api,
        language: ctx.language,
        theme: ctx.theme,
        // 옛 본문은 자기 폭을 요구할 수 있었다. 새 계약에서 폭은 표면이 소유하므로,
        // 이 요구는 표면의 extra-width 힌트로 그대로 흘려보낸다.
        requestExtraWidth: ctx.requestExtraWidth,
        surfaces: ctx.legacySurfaces,
        launchOperation: ctx.legacyLaunchOperation,
        pathContext: { kind: "root", relPath: null, label: "" },
      }) ?? null;
    },
    // 옛 패널은 닫히면 사라지는 것을 전제로 쓰였다. keepAlive를 켜면 지금까지 없던 수명이
    // 생겨 폴링·구독이 조용히 계속 돈다 — 새 계약으로 옮기며 스스로 선언하게 둔다.
    ...(panel.defaultWidth === undefined ? {} : { defaultWidth: panel.defaultWidth }),
    // 옛 검색은 결과가 값을 돌려주지 않고 콜백 안에서 스스로 착지했다. 그 동작을 그대로
    // 유지하려면 반환 없는 activate로 감싼다 — 호스트는 열 자리를 모르므로 패널만 연다.
    ...(panel.search
      ? {
        search: async (request) => {
          const results = await panel.search!(request);
          return results.map((result) => ({
            id: result.id,
            title: result.title,
            ...(result.subtitle === undefined ? {} : { subtitle: result.subtitle }),
            ...(result.kind === undefined ? {} : { kind: result.kind }),
            activate: async () => {
              await result.activate();
              return { paneId: panel.id };
            },
          }));
        },
      }
      : {}),
  };

  return { entry, panes: [pane], projected: true, core };
}

function resolveEntryTitle(panel: RailPanelDescriptor, language: string | undefined): string {
  const { title } = panel;
  if (typeof title === "function") return title((language ?? "en") as never);
  return title;
}

/**
 * 새 계약으로 등록된 엔트리와 페인을 묶는다. 엔트리가 이름으로 가리킨 페인이 없으면 그
 * 엔트리는 아무것도 세우지 못하므로, 조용히 빈 표면을 여는 대신 목록에서 뺀다.
 */
function bindNative(
  entries: readonly RailEntryDescriptor[],
  panes: readonly PaneDescriptor[],
): readonly RailEntryBinding[] {
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const bound: RailEntryBinding[] = [];

  for (const entry of entries) {
    const wanted = entry.panes ?? [];
    const resolved = wanted.map((id) => byId.get(id)).filter((pane): pane is PaneDescriptor => pane !== undefined);
    if (wanted.length > 0 && resolved.length === 0 && !entry.activate) {
      console.warn(`[fleet-console] rail entry "${entry.id}" names no registered pane; skipping.`);
      continue;
    }
    bound.push({ entry, panes: resolved, projected: false });
  }

  return bound;
}

export function useRailEntries(side: "right" = "right"): readonly RailEntryBinding[] {
  const registry = usePluginRegistry();
  // 레지스트리를 만드는 경로가 새 필드를 아직 싣지 않을 수 있다(외부 합성·테스트 대역). 그때
  // 레일 전체가 죽는 것보다 그 기여만 비어 있는 편이 낫다.
  const railPanels = registry.railPanels ?? [];
  const railEntries = registry.railEntries ?? [];
  const panes = registry.panes ?? [];

  return useMemo(() => {
    const native = bindNative(railEntries, panes);
    const nativeIds = new Set(native.map((binding) => binding.entry.id));

    // 코어가 먼저, 그다음 플러그인 — 합성 순서는 옛 레지스트리와 같다. 같은 id를 가진
    // 네이티브 등록이 있으면 투영을 버린다: 옮겨 온 쪽이 언제나 이긴다.
    const coreProjected = BUILT_IN_RAIL_PANELS.filter((panel) => !nativeIds.has(panel.id)).map((panel) => projectPanel(panel, true));
    const pluginProjected = railPanels.filter((panel) => !nativeIds.has(panel.id)).map((panel) => projectPanel(panel));

    return [...coreProjected, ...native, ...pluginProjected]
      .filter((binding) => (binding.entry.side ?? "right") === side);
  }, [panes, railEntries, railPanels, side]);
}

/** 모든 페인을 id로 찾는 색인. `panes.open`이 이름만 받아 여는 근거다. */
export function usePaneIndex(): ReadonlyMap<string, PaneDescriptor> {
  const bindings = useRailEntries();
  return useMemo(() => {
    const index = new Map<string, PaneDescriptor>();
    for (const binding of bindings) {
      for (const pane of binding.panes) index.set(pane.id, pane);
    }
    return index;
  }, [bindings]);
}
