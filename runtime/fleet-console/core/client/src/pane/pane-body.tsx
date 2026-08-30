import { useCallback, useEffect, useMemo, useState } from "react";

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
 * 페인 컨텍스트와 본문 — 마운트가 어디든 같은 것을 그린다.
 *
 * 레일 표면과 확대 표면이 이 한 컴포넌트를 공유하는 것이 '확대'가 공통 기능인 근거다. 페인은
 * 자기가 어느 마운트에 서 있는지 `ctx.mount`로 알 뿐, 확대를 위한 코드를 따로 쓰지 않는다.
 *
 * 캡션은 여기 없다. 캡션을 세울지는 마운트가 정한다 — 레일에서는 detail 페인만, 확대 표면에서는
 * 호스트 슬롯 머리가 이미 그 일을 하므로 아무도 세우지 않는다.
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
  // 상태로 드는 이유는 StrictMode다. 개발 빌드는 setup → cleanup → setup을 한 번 예행하는데,
  // ref에 든 controller를 그대로 재사용하면 두 번째 setup이 이미 abort된 signal을 물려받아
  // 본문의 첫 fetch가 태어나자마자 죽는다. 죽은 것을 만나면 새로 만들어 다시 그린다.
  const [controller, setController] = useState(() => new AbortController());
  useEffect(() => {
    if (controller.signal.aborted) {
      setController(new AbortController());
      return;
    }
    return () => { controller.abort(); };
  }, [controller]);

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
      // 남의 페인을 닫는 경로가 열기로 새면 계약이 뒤집힌다 — 닫으라고 부른 페인이 대신
      // 서고, 그 페인이 담고 있던 대상까지 빈 params로 지워진다.
      close: (paneId) => { if (paneId === undefined || paneId === descriptor.id) onClose(); else onCloseOther?.(paneId); },
      replaceParams: onReplaceParams,
      isOpen: (paneId) => isOpen?.(paneId) ?? (paneId === descriptor.id && visible),
    },
    signal: controller.signal,
    ...(requestExtraWidth === undefined ? {} : { requestExtraWidth }),
    language,
    theme,
    legacySurfaces,
    legacyLaunchOperation,
  }), [api, descriptor.id, descriptor.role, focused, handleOpen, instanceId, isOpen, language, legacyLaunchOperation, legacySurfaces, lifecycle, mount, onClose, onCloseOther, onOpen, onReplaceParams, params, preferences, requestExtraWidth, theaterId, theme, visible, width]);

  return ctx;
}

/** 만들어진 컨텍스트로 본문만 그린다. 캡션은 같은 ctx를 호출자에게서 받아 쓴다. */
export function PaneBody({ descriptor, ctx }: { readonly descriptor: PaneDescriptor; readonly ctx: HostPaneContext }) {
  return <>{descriptor.render(ctx)}</>;
}
