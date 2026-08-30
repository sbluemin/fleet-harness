import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneDescriptor, PaneMount, PaneOpenRequest } from "@fleet-console/sdk/pane";
import type {
  ClientApiCapability,
  ClientExpandedSurfacesCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
  ConsoleTheme,
} from "@fleet-console/sdk/plugin";

import type { HostPaneContext } from "./pane-registry.js";

/**
 * 페인 본문 — 마운트가 어디든 같은 것을 그린다.
 *
 * 레일 표면과 확대 표면이 이 한 컴포넌트를 공유하는 것이 '확대'가 공통 기능인 근거다. 페인은
 * 자기가 어느 마운트에 서 있는지 `ctx.mount`로 알 뿐, 확대를 위한 코드를 따로 쓰지 않는다.
 *
 * 캡션은 여기 없다. 캡션을 세울지는 마운트가 정한다 — 레일에서는 detail 페인만, 확대 표면에서는
 * 호스트 슬롯 머리가 이미 그 일을 하므로 아무도 세우지 않는다.
 */
export interface PaneBodyProps {
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
  readonly isOpen?: (paneId: string) => boolean;
  readonly requestExtraWidth?: (px: number | null) => void;
  readonly legacySurfaces?: ClientExpandedSurfacesCapability;
  readonly legacyLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
  /** 컨텍스트가 만들어질 때 호출된다 — 캡션 액션처럼 같은 ctx를 써야 하는 호출자를 위해. */
  readonly onContext?: (ctx: HostPaneContext) => void;
}

export function PaneBody({
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
  isOpen,
  requestExtraWidth,
  legacySurfaces,
  legacyLaunchOperation,
  onContext,
}: PaneBodyProps) {
  const abortRef = useRef<AbortController | null>(null);
  abortRef.current ??= new AbortController();

  // 계약은 "페인이 실제로 헐릴 때 abort된다"고 말한다. 이 cleanup이 없으면 signal은 영원히
  // 열린 채로 남아, 닫힌 페인의 요청과 watcher가 다음 페인 위에 착지한다.
  useEffect(() => {
    const controller = abortRef.current!;
    return () => { controller.abort(); };
  }, []);

  const handleOpen = useCallback((request: PaneOpenRequest) => { onOpen?.(request); }, [onOpen]);

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
    panes: {
      open: handleOpen,
      close: (paneId) => { if (paneId === undefined || paneId === descriptor.id) onClose(); else onOpen?.({ paneId, params: {} }); },
      replaceParams: onReplaceParams,
      isOpen: (paneId) => isOpen?.(paneId) ?? (paneId === descriptor.id && visible),
    },
    signal: abortRef.current!.signal,
    ...(requestExtraWidth === undefined ? {} : { requestExtraWidth }),
    language,
    theme,
    legacySurfaces,
    legacyLaunchOperation,
  }), [api, descriptor.id, descriptor.role, focused, handleOpen, instanceId, isOpen, language, legacyLaunchOperation, legacySurfaces, lifecycle, mount, onClose, onOpen, onReplaceParams, params, preferences, requestExtraWidth, theaterId, theme, visible, width]);

  useEffect(() => { onContext?.(ctx); }, [ctx, onContext]);

  return <>{descriptor.render(ctx)}</>;
}
