import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";

import type { ClientApiCapability, ClientExpandedSurfacesCapability } from "@fleet-console/sdk/plugin";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneDescriptor, PaneOpenRequest } from "@fleet-console/sdk/pane";
import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { createHostCapabilities } from "../plugin-capabilities.js";
import { PaneCaption } from "./pane-caption.js";
import type { HostPaneContext, RailEntryBinding } from "./pane-registry.js";
import { closePane, focusPane, openPane, useFocusedPaneId, useRailPanes } from "./pane-store.js";

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
        descriptor={primary}
        instanceId={primaryInstance?.instanceId ?? `pane-primary-${primary.id}`}
        params={primaryInstance?.params ?? {}}
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
 * 보이지 않는 keepAlive 페인도 렌더는 계속된다. 대신 `inert`와 `aria-hidden`으로 포커스와
 * 보조기술에서 빼고, 본문은 `ctx.visible`로 그 사실을 알아 폴링을 스스로 멈춘다. 언마운트하지
 * 않는 것이 요점이다 — 언마운트하면 PTY와 읽던 자리가 사라진다.
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
  const abortRef = useRef<AbortController | null>(null);
  abortRef.current ??= new AbortController();

  const handleOpen = useCallback((request: PaneOpenRequest) => { openPane(request); }, []);
  const handleClose = useCallback((paneId?: string) => {
    closePane(paneId ?? descriptor.id, { keepAlive: descriptor.keepAlive === true });
  }, [descriptor.id, descriptor.keepAlive]);

  const ctx = useMemo<HostPaneContext>(() => ({
    paneId: descriptor.id,
    instanceId,
    params,
    role: descriptor.role,
    mount: "rail",
    // 실제 폭은 표면이 정한다. 본문은 컨테이너 쿼리로 스스로 열화하므로, 측정값을 흘리는 것보다
    // 0을 주고 CSS에 맡기는 편이 렌더 루프를 만들지 않는다.
    width: bodyRef.current?.clientWidth ?? 0,
    visible,
    focused,
    theaterId,
    api,
    lifecycle: HOST_CAPABILITIES.lifecycle,
    preferences: HOST_CAPABILITIES.preferences,
    panes: {
      open: handleOpen,
      close: handleClose,
      replaceParams: (next) => { openPane({ paneId: descriptor.id, params: next, focus: false }); },
      isOpen: (paneId) => paneId === descriptor.id ? visible : false,
    },
    signal: abortRef.current!.signal,
    language,
    theme,
    legacyRequestExtraWidth: onRequestExtraWidth,
    legacySurfaces: surfaces,
    legacyLaunchOperation: onLaunchOperation,
  }), [api, descriptor.id, descriptor.role, focused, handleClose, handleOpen, instanceId, language, onLaunchOperation, onRequestExtraWidth, params, surfaces, theaterId, theme, visible]);

  const title = resolveLocalizedText(descriptor.title(ctx), language);
  const hasCaption = descriptor.hideCaption !== true;

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
          {...(descriptor.role === "primary" ? {} : { onClose: () => handleClose() })}
        />
      ) : null}
      <div className="rail-pane-body" ref={bodyRef} aria-labelledby={hasCaption ? `pane-caption-${descriptor.id}` : undefined}>
        {descriptor.render(ctx)}
      </div>
    </div>
  );
}
