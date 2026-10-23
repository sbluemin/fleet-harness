import { useCallback, useEffect, useMemo, useState } from "react";

import type { ClientMobileObjectiveCapability } from "../../../../../features/workspace/shared/mobile.js";
import type { ConsoleTheme } from "../../../../../features/settings/shared/theme.js";
import type { ObjectiveKindDescriptor, ObjectiveRenderContext, ObjectiveRuntimeState } from "../../../../../features/execution/shared/client-contract.js";

import { useT } from "../../i18n/index.js";
import type { createHostCapabilities } from "../../integration/feature-capabilities.js";
import type { ObjectiveGeometry, ObjectiveRecord } from "../../integration/types.js";
import { rememberArchivedTitle } from "./mobile-toast.js";
import { objectiveRecordHarnessLabel } from "./mobile-objective-label.js";
import { mobileObjectiveMenuItems } from "./mobile-objective-menu.js";
import { ConversationAvatar, conversationStateWord, useMobileConversationOf } from "./mobile-conversation-row.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { closeMobileObjective } from "./mobile-objective-url.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { closeTopBackLayer } from "./mobile-back.js";
import { pushMobileSheet, setMobileDestination, setMobileObjectiveMenu, useMobileObjectiveMenu } from "./mobile-store.js";
import { ObjectiveBodySlot, type ObjectiveBodyConfig } from "./objective-body-pool.js";
import { ledgerObjectiveId, openLedger } from "../../../../../features/execution/client/agent/chat/group/index.js";
import { useConversationPillTakeover } from "../../../../../features/workspace/client/conversation/conversation-slots.js";

/**
 * An open objectiveRecord is its body under the top bar the shell draws: ‹ back to the conversation list, a pill with the
 * avatar, title and status line (it opens the conversation info screen) and a ⋮ menu: rename, whatever the body adds through
 * `mobileObjective.setMenuItems` (the chat/terminal switch, keep-allowing computer use), then archive.
 * When a commander has a member selected (`bodyObjective`), the body, title and avatar are that member's while rename and
 * archive stay with the screen's owner — the same split as the desktop commander panel, whose frame stays its own.
 */
export function MobileSessionView({ objectiveRecord, theme, language, active, runtimeState, objectiveRecordRuntime, objectiveRecordKinds, capabilities, onActivate, onClose, bodyObjective = null, covered = false }: {
  readonly objectiveRecord: ObjectiveRecord;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly active: boolean;
  readonly runtimeState: ObjectiveRuntimeState | null;
  readonly objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>;
  readonly objectiveRecordKinds: readonly ObjectiveKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  /** 이 화면이 보일 본문의 주인 — 없으면 자기 자신. 본문의 닫기는 지휘관 본문으로 돌아가는 것이다. */
  readonly bodyObjective?: { readonly objectiveRecord: ObjectiveRecord; readonly runtimeState: ObjectiveRuntimeState | null; readonly onClose: () => void } | null;
  /** 대화 정보 화면이 위를 덮고 있다 — 본문은 그대로 살려 두고(PTY·소켓·⋮ 항목) 막대와 눌림만 양보한다. */
  readonly covered?: boolean;
}) {
  const t = useT();
  const bodyOwner = bodyObjective?.objectiveRecord ?? objectiveRecord;
  const [geometry, setGeometry] = useState<ObjectiveGeometry>({ x: 0, y: 0, width: 390, height: 640, zIndex: 0 });
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
  const memberBodyId = bodyObjective?.objectiveRecord?.id ?? null;
  useEffect(() => {
    if (memberBodyId === null || covered) return;
    // 폰의 구성원 원장은 틀 없이 본문을 바꾼다 — 풀의 본문 이동과 전언 pill 정리가 끝난 뒤 본문 시작이 포커스를 받는다.
    const frame = requestAnimationFrame(() => measureTarget?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [memberBodyId, covered, measureTarget]);

  // 세션 머리의 보관도 데스크톱과 같이 한 번에 끝난다 — 되돌리기는 같은 토스트가 맡는다.
  const archive = () => {
    rememberArchivedTitle(objectiveRecord.id, objectiveRecord.title);
    onClose();
  };

  // 본문이 ⋮에 끼운 항목(보기 전환·계속 허용 …)과 호스트 시트 문법의 확인 — 이 Objective 한 개 몫으로 정체를 고정한다.
  const bodyItems = useMobileObjectiveMenu(bodyOwner.id);
  const mobileObjective = useMemo<ClientMobileObjectiveCapability>(() => ({
    setMenuItems: (items) => setMobileObjectiveMenu(bodyOwner.id, items),
    confirm: (spec) => new Promise<boolean>((resolve) => pushMobileSheet({ kind: "confirm", spec, resolve })),
  }), [bodyOwner.id]);

  const config: ObjectiveBodyConfig = {
    active,
    mobileObjective,
    geometry,
    objectiveRecord: bodyOwner,
    runtimeState: bodyObjective ? bodyObjective.runtimeState : runtimeState,
    bodyLive: true,
    theme,
    language,
    zoom: 1,
    onActivate,
    onClose: bodyObjective ? bodyObjective.onClose : onClose,
    onGeometryChange: setGeometry,
    // This layout gives the whole surface to the session, so it opens no companion panels. The
    // callbacks stay out rather than being no-ops: their absence is how a plugin reads a host
    // without companions, and a no-op would have it advertise a panel that never opens.
  };

  const title = bodyOwner.title;

  const harnessLabel = objectiveRecordHarnessLabel(bodyOwner, t);
  const conversation = useMobileConversationOf(useConsoleState())(bodyOwner);
  // 본문이 덮는 화면(그룹 대화의 전언 대화 화면)이 이 pill 을 잠깐 바꾼다 — 그룹 대화는 화면 주인(지휘관)의 본문에 선다.
  const pillTakeover = useConversationPillTakeover(covered ? null : objectiveRecord.id);
  const stepBack = () => {
    if (ledgerObjectiveId(objectiveRecord.id) !== null) openLedger(objectiveRecord.id, null);
    else closeMobileObjective();
  };
  // 머리: ‹(대화 목록) · 아바타와 제목·상태 한 줄이 든 pill(누르면 대화 정보) · ⋮. 이름 변경·보관은 화면 주인의 것이다.
  useClaimMobileBar(covered ? null : {
    variant: "conversation",
    title: bodyOwner.title,
    leading: "back",
    // 본문이 pill 을 바꾼 동안(전언 대화 화면) ‹ 는 그 화면부터 닫고, 원장(구성원·지휘관)을 보는 동안에는 그룹 대화로 돌아간다.
    onBack: pillTakeover ? () => { if (!closeTopBackLayer()) stepBack(); } : stepBack,
    pill: {
      key: `${bodyOwner.id}\u0001${bodyOwner.title}\u0001${conversation.face}\u0001${conversation.minis.map((entry) => `${entry.objectiveRecord.id}:${entry.mark}`).join(",")}\u0001${harnessLabel ?? ""}\u0001${pillTakeover?.key ?? ""}`,
      label: t("mobile.conv.infoAria", { title: bodyOwner.title }),
      onPress: () => setMobileDestination({ kind: "info" }),
      takeover: pillTakeover,
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
      label: t("mobile.bar.objectiveRecordMenu"),
      // 이름 변경·보관은 화면 주인의 것이다 — 구성원 본문을 보는 동안에도 메뉴 머리는 그 주인을 말한다.
      caption: objectiveRecord.title,
      items: mobileObjectiveMenuItems({ objectiveRecord, bodyItems, t, onArchive: archive }),
    },
  });

  return (
    <section className={`mobile-session-view${covered ? " is-covered" : ""}`} aria-hidden={covered || undefined}>
      <div className="mobile-session-body" ref={setMeasureTarget} role="region" aria-label={title} tabIndex={-1}>
        <ObjectiveBodySlot key={bodyOwner.id} objectiveId={bodyOwner.id} config={config} className="mobile-objective-body-slot" />
      </div>
    </section>
  );
}
