import { useCallback, useEffect, useMemo, useState } from "react";

import type { ClientMobileOperationCapability, ConsoleTheme, OperationKindDescriptor, OperationRenderContext, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { getIdleArrivalIds } from "../../../../../features/execution/client/operation-marks.js";
import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { useT } from "../../i18n/index.js";
import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";
import type { OperationGeometry, OperationNode } from "../../integration/types.js";
import { openQuickLaunch } from "../../integration/store.js";
import { rememberArchivedTitle } from "./mobile-toast.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { pushMobileSheet, setMobileOperationMenu, useMobileOperationMenu } from "./mobile-store.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

/**
 * An open operation is its body under the top bar the shell draws: the status glyph, the title, a new-Operation
 * button and a ⋮ menu: rename, whatever the body adds through `mobileOperation.setMenuItems` (the chat/terminal switch,
 * keep-allowing computer use), then archive.
 * When a commander has a member selected (`bodyOperation`), the body, title and glyph are that member's while rename and
 * archive stay with the screen's owner — the same split as the desktop commander panel, whose frame stays its own.
 */
export function MobileSessionView({ operation, theme, language, active, runtimeState, operationRuntime, operationKinds, capabilities, onActivate, onClose, bodyOperation = null }: {
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
  /** 이 화면이 보일 본문의 주인 — 없으면 자기 자신. 본문의 닫기는 지휘관 본문으로 돌아가는 것이다. */
  readonly bodyOperation?: { readonly operation: OperationNode; readonly runtimeState: OperationRuntimeState | null; readonly onClose: () => void } | null;
}) {
  const t = useT();
  const bodyOwner = bodyOperation?.operation ?? operation;
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
    rememberArchivedTitle(operation.id, operation.title);
    onClose();
  };

  // 본문이 ⋮에 끼운 항목(보기 전환·계속 허용 …)과 호스트 시트 문법의 확인 — 이 Operation 한 개 몫으로 정체를 고정한다.
  const bodyItems = useMobileOperationMenu(bodyOwner.id);
  const mobileOperation = useMemo<ClientMobileOperationCapability>(() => ({
    setMenuItems: (items) => setMobileOperationMenu(bodyOwner.id, items),
    confirm: (spec) => new Promise<boolean>((resolve) => pushMobileSheet({ kind: "confirm", spec, resolve })),
  }), [bodyOwner.id]);

  const config: OperationBodyConfig = {
    active,
    mobileOperation,
    geometry,
    operation: bodyOwner,
    runtimeState: bodyOperation ? bodyOperation.runtimeState : runtimeState,
    bodyLive: true,
    theme,
    language,
    zoom: 1,
    onActivate,
    onClose: bodyOperation ? bodyOperation.onClose : onClose,
    onGeometryChange: setGeometry,
    // This layout gives the whole surface to the session, so it opens no companion panels. The
    // callbacks stay out rather than being no-ops: their absence is how a plugin reads a host
    // without companions, and a no-op would have it advertise a panel that never opens.
  };

  const title = bodyOwner.title;

  const session = bodyOwner.payload.session && typeof bodyOwner.payload.session === "object" && !Array.isArray(bodyOwner.payload.session)
    ? bodyOwner.payload.session as Record<string, unknown>
    : null;
  const harnessName = session?.harness === "claude-code" ? "Claude Code" : undefined;
  // 「{하네스} · 채팅|터미널」 — 에이전트 Operation은 보는 방식까지 말한다(S-26·S-30).
  const harnessLabel = harnessName ? `${harnessName} · ${t(bodyOwner.payload.chatMode === true ? "mobile.bar.viewChat" : "mobile.bar.viewTerminal")}` : undefined;
  const mark = resolveOperationMarkVisual({
    activity: resolveOperationActivity(bodyOwner, operationRuntime),
    operationId: bodyOwner.id,
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
      // 이름 변경·보관은 화면 주인의 것이다 — 구성원 본문을 보는 동안에도 메뉴 머리는 그 주인을 말한다.
      caption: operation.title,
      // 순서: 이름 변경, 본문이 끼운 항목들, 보관.
      items: [
        { id: "rename", icon: <MobileIcon name="pencil" size={20} />, label: t("mobile.menu.rename"), run: () => pushMobileSheet({ kind: "rename", operationId: operation.id }) },
        ...bodyItems,
        { id: "archive", icon: <MobileIcon name="archive" size={20} />, label: t("mobile.menu.archive"), run: archive },
      ],
    },
  });

  return (
    <section className="mobile-session-view">
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot key={bodyOwner.id} operationId={bodyOwner.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}
