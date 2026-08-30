import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";

import type { ClientApiCapability, ClientExpandedSurfacesCapability } from "@fleet-console/sdk/plugin";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneDescriptor, PaneOpenRequest } from "@fleet-console/sdk/pane";
import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { createHostCapabilities } from "../plugin-capabilities.js";
import { EXPANDED_PANE_SURFACE_ID } from "./expanded-pane-surface.js";
import { PaneBody, usePaneContext } from "./pane-body.js";
import { PaneCaption } from "./pane-caption.js";
import type { HostPaneContext, RailEntryBinding } from "./pane-registry.js";
import { closePane, focusPane, openPane, useFocusedPaneId, useRailPanes } from "./pane-store.js";

/** 남의 페인을 닫는 경로 — 스토어 호출을 그대로 넘긴다. */
const closePaneById = (paneId: string) => { closePane(paneId); };

/**
 * 레일 표면 — 활성 엔트리가 세우는 페인들을 담는 그릇.
 *
 * 표면이 소유하는 것: 열의 배치, 분할선, 캡션, 포커스. 페인이 소유하는 것: 캡션 아래 전부.
 * 이 경계가 계약의 실행부다.
 *
 * primary는 엔트리가 열리면 자동으로 선다. detail은 `panes.open`이 부를 때 선다 — 그래서
 * 등록은 독립이고 전이는 호출이라는 계약이 여기서 실제로 성립한다.
 */

// 능력 객체를 렌더마다 새로 만들면 컨텍스트가 매번 바뀌어 본문이 재마운트된다 —
// keepAlive가 지키려는 것을 정작 호스트가 깨뜨리는 자리다.
const HOST_CAPABILITIES = createHostCapabilities();

// 렌더마다 새 `{}`를 만들면 ctx의 useMemo가 매번 깨져 본문이 다시 그려진다.
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export interface RailSurfaceProps {
  readonly binding: RailEntryBinding;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  readonly surfaces?: ClientExpandedSurfacesCapability;
  readonly onRequestExtraWidth?: (px: number | null) => void;
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

export const RailSurface = memo(function RailSurface({
  binding,
  theaterId,
  api,
  language,
  theme,
  surfaces,
  onRequestExtraWidth,
  onLaunchOperation,
}: RailSurfaceProps) {
  const openInstances = useRailPanes();
  const focusedPaneId = useFocusedPaneId();

  const primary = useMemo(
    () => binding.panes.find((pane) => pane.role === "primary") ?? binding.panes[0],
    [binding.panes],
  );

  // 이 엔트리에 속한 페인만 세운다. 다른 엔트리의 페인이 열려 있어도 그것은 그 표면의 일이다.
  const owned = useMemo(() => new Map(binding.panes.map((pane) => [pane.id, pane])), [binding.panes]);
  const extras = useMemo(
    () => openInstances
      .filter((instance) => instance.paneId !== primary?.id && owned.has(instance.paneId))
      .map((instance) => ({ instance, descriptor: owned.get(instance.paneId)! })),
    [openInstances, owned, primary?.id],
  );

  if (!primary) return null;

  const primaryInstance = openInstances.find((instance) => instance.paneId === primary.id);

  return (
    <div className={`rail-surface${extras.length > 0 ? " is-split" : ""}`} data-pane-count={extras.length + 1}>
      <PaneHost
        key={primary.id}
        descriptor={primary}
        instanceId={primaryInstance?.instanceId ?? `pane-primary-${primary.id}`}
        params={primaryInstance?.params ?? EMPTY_PARAMS}
        visible
        focused={focusedPaneId === primary.id}
        theaterId={theaterId}
        api={api}
        language={language}
        theme={theme}
        surfaces={surfaces}
        onRequestExtraWidth={onRequestExtraWidth}
        onLaunchOperation={onLaunchOperation}
      />
      {extras.map(({ instance, descriptor }) => (
        <PaneHost
          key={instance.instanceId}
          descriptor={descriptor}
          instanceId={instance.instanceId}
          params={instance.params}
          visible={instance.visible}
          focused={focusedPaneId === descriptor.id}
          theaterId={theaterId}
          api={api}
          language={language}
          theme={theme}
          surfaces={surfaces}
          onRequestExtraWidth={onRequestExtraWidth}
          onLaunchOperation={onLaunchOperation}
        />
      ))}
    </div>
  );
});

interface PaneHostProps {
  readonly descriptor: PaneDescriptor;
  readonly instanceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  readonly surfaces?: ClientExpandedSurfacesCapability;
  readonly onRequestExtraWidth?: (px: number | null) => void;
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

/**
 * 페인 한 칸 — 캡션과 본문.
 *
 * **캡션은 detail 페인에만 선다.** primary는 표면과 수명을 같이하므로 닫을 것도 확대할 것도
 * 없고, 무엇인지는 레일 아이콘이 이미 말한다 — 거기에 이름 한 줄을 더 세우면 30px을 낭비하고
 * 같은 말을 두 번 하게 된다. aside도 본문에 종속된 부속 열이라 같은 이유로 캡션이 없다.
 *
 * 보이지 않는 keepAlive 페인도 렌더는 계속된다. 대신 `inert`와 `aria-hidden`으로 포커스와
 * 보조기술에서 빼고, 본문은 `ctx.visible`로 그 사실을 알아 폴링을 스스로 멈춘다.
 */
function PaneHost({
  descriptor,
  instanceId,
  params,
  visible,
  focused,
  theaterId,
  api,
  language,
  theme,
  surfaces,
  onRequestExtraWidth,
  onLaunchOperation,
}: PaneHostProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    closePane(descriptor.id, { keepAlive: descriptor.keepAlive === true });
  }, [descriptor.id, descriptor.keepAlive]);

  const handleReplaceParams = useCallback((next: Readonly<Record<string, string>>) => {
    openPane({ paneId: descriptor.id, params: next, focus: false });
  }, [descriptor.id]);

  // 확대는 페인마다 만드는 기능이 아니라 표면 계약의 공통 동작이다 — 호스트 내장 표면이
  // paneId를 받아 같은 본문을 캔버스 위에 세운다. 그래서 이 버튼은 어떤 detail 페인에도
  // 같은 방식으로 선다.
  const canExpand = descriptor.mounts.includes("expanded");
  const handleExpand = useCallback(() => {
    surfaces?.open({ surfaceId: EXPANDED_PANE_SURFACE_ID, params: { ...params, paneId: descriptor.id } });
    closePane(descriptor.id, { keepAlive: descriptor.keepAlive === true });
  }, [descriptor.id, descriptor.keepAlive, params, surfaces]);

  const ctx = usePaneContext({
    descriptor,
    mount: "rail",
    instanceId,
    params,
    visible,
    focused,
    // 폭은 표면이 정한다. 본문은 컨테이너 쿼리로 스스로 열화하므로, 측정값을 렌더마다 흘리면
    // 컨텍스트가 매번 새로 만들어져 본문이 다시 그려진다.
    width: descriptor.defaultWidth ?? 0,
    theaterId,
    api,
    lifecycle: HOST_CAPABILITIES.lifecycle,
    preferences: HOST_CAPABILITIES.preferences,
    language,
    theme,
    onClose: handleClose,
    onReplaceParams: handleReplaceParams,
    onOpen: openPane,
    onCloseOther: closePaneById,
    ...(onRequestExtraWidth === undefined ? {} : { requestExtraWidth: onRequestExtraWidth }),
    legacySurfaces: surfaces,
    legacyLaunchOperation: onLaunchOperation,
  });

  const hasCaption = descriptor.role === "detail" && descriptor.hideCaption !== true;
  const title = resolveLocalizedText(descriptor.title(ctx), language);

  return (
    <div
      className={`rail-pane role-${descriptor.role}${focused ? " is-focused" : ""}${visible ? "" : " is-parked"}`}
      data-pane={descriptor.id}
      hidden={!visible}
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
      style={descriptor.defaultWidth === undefined ? undefined : { ["--pane-width" as string]: `${descriptor.defaultWidth}px` }}
      onFocusCapture={() => { if (visible) focusPane(descriptor.id); }}
    >
      {hasCaption ? (
        <PaneCaption
          title={title}
          paneId={descriptor.id}
          focused={focused}
          actions={descriptor.captionActions?.(ctx) as ReactNode}
          {...(canExpand && surfaces ? { onExpand: handleExpand } : {})}
          onClose={handleClose}
        />
      ) : null}
      <div className="rail-pane-body" ref={bodyRef} aria-labelledby={hasCaption ? `pane-caption-${descriptor.id}` : undefined}>
        <PaneBody descriptor={descriptor} ctx={ctx} />
      </div>
    </div>
  );
}
