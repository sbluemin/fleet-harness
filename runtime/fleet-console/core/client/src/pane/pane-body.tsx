import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneDescriptor, PaneMount, PaneOpenRequest, PanesCapability } from "@fleet-console/sdk/pane";
import type {
  ClientApiCapability,
  ClientExpandedSurfacesCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
  ConsoleTheme,
} from "@fleet-console/sdk/plugin";

import type { HostPaneContext } from "./pane-registry.js";

/**
 * 페인 컨텍스트와 본문 — 마운트가 어디든 같은 것을 그린다.
 *
 * 레일 표면과 확대 표면이 이 한 컴포넌트를 공유하는 것이 '확대'가 공통 기능인 근거다. 페인은
 * 자기가 어느 마운트에 서 있는지 `ctx.mount`로 알 뿐, 확대를 위한 코드를 따로 쓰지 않는다.
 *
 * 캡션은 여기 없다. 캡션을 세울지는 마운트가 정한다 — 레일에서는 detail 페인만, 확대 표면에서는
 * 호스트 페인 머리가 이미 그 일을 하므로 아무도 세우지 않는다.
 */
export interface PaneContextInput {
  readonly descriptor: PaneDescriptor;
  readonly mount: PaneMount;
  readonly instanceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly width: number;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  readonly onClose: () => void;
  readonly onReplaceParams: (next: Readonly<Record<string, string>>) => void;
  readonly onOpen?: (request: PaneOpenRequest) => void;
  /** 다른 페인을 닫는다. 생략하면 자기 자신 외에는 닫지 못한다. */
  readonly onCloseOther?: (paneId: string) => void;
  readonly isOpen?: (paneId: string) => boolean;
  readonly requestExtraWidth?: (px: number | null) => void;
  readonly legacySurfaces?: ClientExpandedSurfacesCapability;
  readonly legacyLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

export function usePaneContext({
  descriptor,
  mount,
  instanceId,
  params,
  visible,
  focused,
  width,
  theaterId,
  api,
  lifecycle,
  preferences,
  language,
  theme,
  onClose,
  onReplaceParams,
  onOpen,
  onCloseOther,
  isOpen,
  requestExtraWidth,
  legacySurfaces,
  legacyLaunchOperation,
}: PaneContextInput): HostPaneContext {
  // 계약은 "페인이 실제로 헐릴 때 abort된다"고 말한다. cleanup이 없으면 signal은 영원히
  // 열린 채로 남아, 닫힌 페인의 요청과 watcher가 다음 페인 위에 착지한다.
  //
  // 까다로운 쪽은 StrictMode다. 개발 빌드는 setup → cleanup → setup을 한 번 예행하고, 그
  // 순환은 렌더 사이에 일어나지 않는다. 그래서 죽은 controller를 상태로 교체하면 늦는다 —
  // 교체가 반영되기 전에 본문의 `[]` effect가 이미 재시작해 abort된 signal을 쓴다. cleanup이
  // 그 자리에서 다음 것을 세우고, 컨텍스트는 값이 아니라 getter로 지금 살아 있는 것을 읽는다.
  const controllerRef = useRef<AbortController | null>(null);
  controllerRef.current ??= new AbortController();
  useEffect(() => {
    const controller = controllerRef.current!;
    return () => {
      controller.abort();
      controllerRef.current = new AbortController();
    };
  }, []);

  const handleOpen = useCallback((request: PaneOpenRequest) => { onOpen?.(request); }, [onOpen]);

  /**
   * 여닫는 창구는 컨텍스트와 수명이 다르다.
   *
   * ctx는 params·폭·가시성·포커스가 바뀔 때마다 새로 만들어진다(그래야 본문이 새 값을 본다).
   * 그 안에 `panes`를 인라인으로 두면 창구까지 함께 새 객체가 되고, 이것을 의존성에 적은
   * 본문의 effect가 **아무 일도 없었는데 다시 돈다** — 방금 닫은 열을 스스로 다시 여는
   * 종류의 결함이 거기서 태어난다. 창구가 아는 것은 "누가 누구를 여닫는가"뿐이므로 그
   * 정체는 params가 바뀌어도 변할 이유가 없다.
   *
   * `visible`만 ref로 읽는다. `isOpen`의 폴백이 그 값을 필요로 하지만, 그 때문에 창구가
   * 매번 새로 태어나면 안정성이 사라진다.
   */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const panes = useMemo<PanesCapability>(() => ({
    open: handleOpen,
    // 남의 페인을 닫는 경로가 열기로 새면 계약이 뒤집힌다 — 닫으라고 부른 페인이 대신
    // 서고, 그 페인이 담고 있던 대상까지 빈 params로 지워진다.
    close: (paneId) => { if (paneId === undefined || paneId === descriptor.id) onClose(); else onCloseOther?.(paneId); },
    replaceParams: onReplaceParams,
    isOpen: (paneId) => isOpen?.(paneId) ?? (paneId === descriptor.id && visibleRef.current),
  }), [descriptor.id, handleOpen, isOpen, onClose, onCloseOther, onReplaceParams]);

  const ctx = useMemo<HostPaneContext>(() => ({
    paneId: descriptor.id,
    instanceId,
    params,
    role: descriptor.role,
    mount,
    width,
    visible,
    focused,
    theaterId,
    api,
    lifecycle,
    preferences,
    panes,
    get signal() { return controllerRef.current!.signal; },
    ...(requestExtraWidth === undefined ? {} : { requestExtraWidth }),
    language,
    theme,
    legacySurfaces,
    legacyLaunchOperation,
  }), [api, descriptor.id, descriptor.role, focused, instanceId, language, legacyLaunchOperation, legacySurfaces, lifecycle, mount, panes, params, preferences, requestExtraWidth, theaterId, theme, visible, width]);

  return ctx;
}

/** 만들어진 컨텍스트로 본문만 그린다. 캡션은 같은 ctx를 호출자에게서 받아 쓴다. */
export function PaneBody({ descriptor, ctx }: { readonly descriptor: PaneDescriptor; readonly ctx: HostPaneContext }) {
  return <>{descriptor.render(ctx)}</>;
}
