import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { PaneBody, usePaneContext } from "./pane-body.js";
import { getExpandedSurfaceState, openExpandedSurface } from "../expanded-surface/store.js";
import { closePane, openPane } from "./pane-store.js";
import { usePaneIndex } from "./pane-registry.js";

/**
 * 페인을 담는 확대 표면 — 호스트 내장 기여 하나.
 *
 * "확대"가 페인마다 따로 만드는 기능이 아니라 표면 계약의 공통 동작인 이유가 여기다. 어떤
 * detail 페인이든 캡션의 확대 버튼을 누르면 이 표면이 `params.paneId`로 그 페인을 받아
 * 캔버스 위에 세운다. 페인은 자기가 어디에 서 있는지만 `ctx.mount`로 알 뿐, 확대를 위한
 * 코드를 따로 쓰지 않는다.
 *
 * 페인 머리는 호스트가 이미 제목과 닫기를 그린다. 그래서 확대된 페인은 자기 캡션을 세우지
 * 않는다 — 세우면 같은 문장이 두 줄에 겹쳐 선다(Codex 읽기 시트가 지금 그 상태다).
 */
export const EXPANDED_PANE_SURFACE_ID = "pane";

/**
 * 이 페인이 지금 확대 표면에 서 있는가.
 *
 * 계약은 "마운트를 생략하면 그 페인이 이미 서 있는 자리에" 연다고 말한다. 그 규칙이 없으면
 * 확대해 둔 문서를 목록에서 갈아탈 때 같은 페인이 레일에도 함께 서고, **한 페인의 두 사본이
 * 서로 다른 주소를 들고** 각자 자기 주소로 스토어를 되돌리려 든다 — 무한 갱신이다.
 */
export function openExpandedPane(paneId: string, params?: Readonly<Record<string, string>>): void {
  openExpandedSurface({ surfaceId: EXPANDED_PANE_SURFACE_ID, params: { ...params, paneId } });
}

export function isPaneExpanded(paneId: string): boolean {
  return getExpandedSurfaceState().instances.some(
    (instance) => instance.surfaceId === EXPANDED_PANE_SURFACE_ID && instance.params.paneId === paneId,
  );
}

export const expandedPaneSurface: ExpandedSurfaceDescriptor = {
  id: EXPANDED_PANE_SURFACE_ID,
  title: (ctx) => (language) => resolvePaneTitle(ctx, language),
  render: (ctx) => <ExpandedPaneBody ctx={ctx} />,
  minPaneWidth: 420,
};

/**
 * 제목은 페인이 말한다. 서술자를 여기서 찾을 수 없는 경우(플러그인이 사라진 뒤 남은 주소)는
 * 빈 문자열을 주어 호스트가 자기 폴백을 쓰게 둔다 — 없는 것과 고장난 것은 다르다.
 */
function resolvePaneTitle(ctx: ExpandedSurfaceContext, language: string): string {
  const paneId = ctx.params.paneId;
  if (paneId === undefined) return "";
  const descriptor = readPaneDescriptor(paneId);
  if (!descriptor) return "";
  return resolveLocalizedText(descriptor.title(toPaneContext(ctx, descriptor.role)), language as never);
}

// 표면 제목은 렌더 밖(호스트 스토어)에서 불리므로 훅을 쓸 수 없다. 레지스트리 스냅샷을
// 마지막 렌더에서 받아 두고 그 사본을 읽는다 — 페인 목록은 플러그인 로드 뒤 바뀌지 않는다.
let paneIndexSnapshot: ReadonlyMap<string, import("@fleet-console/sdk/pane").PaneDescriptor> = new Map();

function readPaneDescriptor(paneId: string) {
  return paneIndexSnapshot.get(paneId);
}

function toPaneContext(ctx: ExpandedSurfaceContext, role: import("@fleet-console/sdk/pane").PaneRole) {
  return {
    paneId: ctx.params.paneId ?? "",
    instanceId: ctx.instanceId,
    params: ctx.params,
    role,
    mount: "expanded" as const,
    width: ctx.paneWidth,
    visible: true,
    focused: ctx.focused,
    theaterId: ctx.theaterId,
    api: ctx.api,
    lifecycle: ctx.lifecycle,
    preferences: ctx.preferences,
    panes: {
      open: () => undefined,
      close: () => ctx.close(),
      replaceParams: (next: Readonly<Record<string, string>>) => ctx.replaceParams({ ...ctx.params, ...next }),
      isOpen: (id: string) => id === ctx.params.paneId,
    },
    signal: new AbortController().signal,
    language: ctx.language,
    theme: ctx.theme,
  };
}

function ExpandedPaneBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const index = usePaneIndex();
  paneIndexSnapshot = index;

  const paneId = ctx.params.paneId;
  const descriptor = paneId === undefined ? undefined : index.get(paneId);
  if (!descriptor) return null;

  return <ExpandedPaneContent descriptor={descriptor} ctx={ctx} />;
}

function ExpandedPaneContent({
  descriptor,
  ctx,
}: {
  readonly descriptor: import("@fleet-console/sdk/pane").PaneDescriptor;
  readonly ctx: ExpandedSurfaceContext;
}) {
  const index = usePaneIndex();
  const paneCtx = usePaneContext({
    descriptor,
    mount: "expanded",
    instanceId: ctx.instanceId,
    params: ctx.params,
    visible: true,
    focused: ctx.focused,
    width: ctx.paneWidth,
    theaterId: ctx.theaterId,
    api: ctx.api,
    lifecycle: ctx.lifecycle,
    preferences: ctx.preferences,
    language: ctx.language,
    theme: ctx.theme,
    onClose: () => ctx.close(),
    onReplaceParams: (next) => ctx.replaceParams({ ...ctx.params, ...next }),
    // 확대된 페인도 다른 페인을 열 수 있어야 한다 — 같은 `PanesCapability`가 두 마운트에
    // 모두 실리는데 한쪽만 무응답이면 계약이 마운트에 따라 달라진다.
    onOpen: (request) => {
      const target = index.get(request.paneId);
      const standing = isPaneExpanded(request.paneId) ? "expanded" as const : undefined;
      const mount = request.mount ?? standing ?? target?.mounts[0] ?? "rail";
      if (mount === "expanded") {
        openExpandedPane(request.paneId, request.params);
        return;
      }
      openPane(request);
    },
    onCloseOther: (paneId) => { closePane(paneId, { keepAlive: index.get(paneId)?.keepAlive === true }); },
  });
  return <PaneBody descriptor={descriptor} ctx={paneCtx} />;
}
