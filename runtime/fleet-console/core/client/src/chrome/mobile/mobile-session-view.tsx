import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ClientMobileOperationCapability, ConsoleTheme, OperationKindDescriptor, OperationRenderContext, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { getIdleArrivalIds } from "../../../../../features/execution/client/operation-marks.js";
import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { useT } from "../../i18n/index.js";
import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";
import type { OperationGeometry, OperationNode } from "../../integration/types.js";
import { openQuickLaunch } from "../../integration/store.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { pushMobileSheet, setMobileOperationMenu, useMobileBarExtraSlot, useMobileOperationMenu } from "./mobile-store.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

/**
 * An open operation is its body under the top bar the shell draws: the status glyph, the title, a new-Operation
 * button and a ⋮ menu (rename, archive). The plugin's caption actions — the chat/terminal switch — ride in the
 * slot the bar leaves open, so a chat session keeps its door back to the terminal.
 */
export function MobileSessionView({ operation, theme, language, active, runtimeState, operationRuntime, operationKinds, capabilities, onActivate, onClose }: {
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
  readonly runtimeState: OperationRuntimeState | null;
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const idleArrivalIds = getIdleArrivalIds();
  const [geometry, setGeometry] = useState<OperationGeometry>({ x: 0, y: 0, width: 390, height: 640, zIndex: 0 });
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const update = () => setGeometry((current) => ({
      ...current,
      width: Math.max(1, element.clientWidth),
      height: Math.max(1, element.clientHeight),
    }));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [measureTarget, setMeasureTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => measure(measureTarget), [measure, measureTarget]);

  // 세션 머리의 보관도 데스크톱과 같이 한 번에 끝난다 — 되돌리기는 같은 토스트가 맡는다.
  const archive = () => {
    onClose();
  };

  // 본문이 ⋮에 끼운 항목(보기 전환·계속 허용 …)과 호스트 시트 문법의 확인 — 이 Operation 한 개 몫으로 정체를 고정한다.
  const bodyItems = useMobileOperationMenu(operation.id);
  const mobileOperation = useMemo<ClientMobileOperationCapability>(() => ({
    setMenuItems: (items) => setMobileOperationMenu(operation.id, items),
    confirm: (spec) => new Promise<boolean>((resolve) => pushMobileSheet({ kind: "confirm", spec, resolve })),
  }), [operation.id]);

  const config: OperationBodyConfig = {
    active,
    mobileOperation,
    geometry,
    operation,
    runtimeState,
    bodyLive: true,
    theme,
    language,
    zoom: 1,
    onActivate,
    onClose,
    onGeometryChange: setGeometry,
    // This layout gives the whole surface to the session, so it opens no companion panels. The
    // callbacks stay out rather than being no-ops: their absence is how a plugin reads a host
    // without companions, and a no-op would have it advertise a panel that never opens.
  };

  const title = operation.title;

  // 캔버스 프레임의 캡션 동작 선반과 같은 것 — 이 레이아웃의 제목 줄이 그 밴드다. 여기서 빠지면
  // 채팅 뷰로 들어간 세션이 터미널로 돌아갈 문을 잃는다(본문에는 더 이상 그 칩이 없다).
  const descriptor = operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const captionActions = descriptor?.captionActions?.({
    mobileOperation,
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    zoom: 1,
    theme,
    language,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    runtime: capabilities.runtime,
    runtimeState,
    bodyLive: true,
    statusDetail: capabilities.statusDetail,
    composer: capabilities.composer,
    navigate: capabilities.navigate,
    shell: capabilities.shell,
    rail: capabilities.rail,
    onActivate,
    onClose,
    onGeometryChange: setGeometry,
    // 본문과 같은 이유로 companion 콜백은 싣지 않는다 — 그 부재가 "여기엔 드로어가 없다"는 말이다.
  } satisfies OperationRenderContext);

  const session = operation.payload.session && typeof operation.payload.session === "object" && !Array.isArray(operation.payload.session)
    ? operation.payload.session as Record<string, unknown>
    : null;
  const harnessLabel = session?.harness === "claude-code" ? "Claude Code" : undefined;
  const mark = resolveOperationMarkVisual({
    activity: resolveOperationActivity(operation, operationRuntime),
    operationId: operation.id,
    idleArrivalIds,
  });
  // 막대의 ⋮ — 이름 변경은 시트로, 보관은 일반 색(되돌리기는 토스트가 맡는다).
  useClaimMobileBar({
    variant: "operation",
    title,
    ...(harnessLabel ? { subtitle: harnessLabel } : {}),
    glyph: mark,
    leading: "menu",
    actions: [{ id: "new", icon: <MobileIcon name="newop" />, label: t("mobile.operations.new"), run: openQuickLaunch }],
    menu: {
      label: t("mobile.bar.operationMenu"),
      caption: title,
      // 순서: 이름 변경, 본문이 끼운 항목들, 보관.
      items: [
        { id: "rename", icon: <MobileIcon name="pencil" size={20} />, label: t("mobile.menu.rename"), run: () => pushMobileSheet({ kind: "rename", operationId: operation.id }) },
        ...bodyItems,
        { id: "archive", icon: <MobileIcon name="archive" size={20} />, label: t("mobile.menu.archive"), run: archive },
      ],
    },
  });
  const extraSlot = useMobileBarExtraSlot();

  return (
    <section className="mobile-session-view">
      {/* 캡션 동작(채팅↔터미널 전환)은 플러그인 소유라 막대가 비워 둔 자리에 포털로 끼운다. */}
      {captionActions && extraSlot ? createPortal(<PluginErrorBoundary fallback={<></>}>{captionActions}</PluginErrorBoundary>, extraSlot) : null}
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot operationId={operation.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}
