import { useCallback, useEffect, useMemo, useState } from "react";

import type { ClientMobileOperationCapability, ConsoleTheme, OperationKindDescriptor, OperationRenderContext, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { useT } from "../../i18n/index.js";
import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";
import type { OperationGeometry, OperationNode } from "../../integration/types.js";
import { rememberArchivedTitle } from "./mobile-toast.js";
import { operationHarnessLabel } from "./mobile-operation-label.js";
import { mobileOperationMenuItems } from "./mobile-operation-menu.js";
import { ConversationAvatar, conversationStateWord, useMobileConversationOf } from "./mobile-conversation-row.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { closeMobileOperation } from "./mobile-operation-url.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { pushMobileSheet, setMobileDestination, setMobileOperationMenu, useMobileOperationMenu } from "./mobile-store.js";
import { OperationBodySlot, type OperationBodyConfig } from "./operation-body-pool.js";

/**
 * An open operation is its body under the top bar the shell draws: ‹ back to the conversation list, a pill with the
 * avatar, title and status line (it opens the conversation info screen) and a ⋮ menu: rename, whatever the body adds through
 * `mobileOperation.setMenuItems` (the chat/terminal switch, keep-allowing computer use), then archive.
 * When a commander has a member selected (`bodyOperation`), the body, title and avatar are that member's while rename and
 * archive stay with the screen's owner — the same split as the desktop commander panel, whose frame stays its own.
 */
export function MobileSessionView({ operation, theme, language, active, runtimeState, operationRuntime, operationKinds, capabilities, onActivate, onClose, bodyOperation = null, covered = false }: {
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
  /** 대화 정보 화면이 위를 덮고 있다 — 본문은 그대로 살려 두고(PTY·소켓·⋮ 항목) 막대와 눌림만 양보한다. */
  readonly covered?: boolean;
}) {
  const t = useT();
  const bodyOwner = bodyOperation?.operation ?? operation;
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

  const harnessLabel = operationHarnessLabel(bodyOwner, t);
  const conversation = useMobileConversationOf(useConsoleState())(bodyOwner);
  // 머리: ‹(대화 목록) · 아바타와 제목·상태 한 줄이 든 pill(누르면 대화 정보) · ⋮. 이름 변경·보관은 화면 주인의 것이다.
  useClaimMobileBar(covered ? null : {
    variant: "conversation",
    title: bodyOwner.title,
    leading: "back",
    onBack: closeMobileOperation,
    pill: {
      key: `${bodyOwner.id}\u0001${bodyOwner.title}\u0001${conversation.face}\u0001${conversation.minis.map((entry) => `${entry.operation.id}:${entry.mark}`).join(",")}\u0001${harnessLabel ?? ""}`,
      label: t("mobile.conv.infoAria", { title: bodyOwner.title }),
      onPress: () => setMobileDestination({ kind: "info" }),
      node: (
        <>
          <span className="mobile-conv-pill-av"><ConversationAvatar conversation={conversation} size={36} /></span>
          <span className="mobile-conv-pill-copy">
            <strong>{bodyOwner.title}</strong>
            <small><span className={`mobile-conv-state is-${conversation.face}`}>{conversationStateWord(conversation.face, t)}</span>{harnessLabel ? ` · ${harnessLabel}` : ""}</small>
          </span>
        </>
      ),
    },
    menu: {
      label: t("mobile.bar.operationMenu"),
      // 이름 변경·보관은 화면 주인의 것이다 — 구성원 본문을 보는 동안에도 메뉴 머리는 그 주인을 말한다.
      caption: operation.title,
      items: mobileOperationMenuItems({ operation, bodyItems, t, onArchive: archive }),
    },
  });

  return (
    <section className={`mobile-session-view${covered ? " is-covered" : ""}`} aria-hidden={covered || undefined}>
      <div className="mobile-session-body" ref={setMeasureTarget}>
        <OperationBodySlot key={bodyOwner.id} operationId={bodyOwner.id} config={config} className="mobile-operation-body-slot" />
      </div>
    </section>
  );
}
