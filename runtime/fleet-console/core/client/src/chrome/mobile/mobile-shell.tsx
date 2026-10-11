import { pluginRuntimeState } from "../../../../../features/execution/client/operation-activity.js";
import { publishConversationClusters, publishConversationSubject } from "../../../../../features/workspace/client/conversation/conversation-slots.js";
import { useOperationClusters } from "../../../../../features/workspace/client/operation-clusters.js";
import { useEffect, useState } from "react";

import type { ConsoleTheme, OperationKindDescriptor, OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";

import { useT } from "../../i18n/index.js";
import { selectNestedBody } from "../../integration/store.js";
import type { OperationNode, OperationNotification } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobilePluginScreen } from "./mobile-plugin-screen.js";
import { MobileSessionView } from "./mobile-session-view.js";
import { MobileTools } from "./mobile-tools.js";
import { pushMobileSheet, setMobileDestination, useMobileDestination } from "./mobile-store.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { MobileArchiveScreen } from "./mobile-archive-screen.js";
import { MobileSearchScreen } from "./mobile-search-screen.js";
import { MobileAttentionScreen } from "./mobile-attention-screen.js";
import { MobileConversationInfo } from "./mobile-conversation-info.js";
import { MobileConversationList } from "./mobile-conversation-list.js";
import { rememberArchivedTitle } from "./mobile-toast.js";
import { readMobileOperationId, replaceMobileOperationId } from "./mobile-operation-url.js";
import "../../styles/mobile.css";

/**
 * `/operations` 안의 화면. 홈은 대화 목록이고 — 열린 Operation이 `?op=` 한 곳에 있으면 그 Operation 화면이 홈 자리에 선다.
 * 그 밖의 화면(확인 필요, 검색, 플러그인 목록, 플러그인이 올린 목적지)은 고른 목적지가 정한다. 다른 목적지로 갔다 돌아와도
 * 열린 Operation은 그 자리에 그대로 있다.
 */
export function MobileShell({ operations, activeOperationId, operationRuntime, operationRuntimeHydration, operationNotifications: _operationNotifications, theme, language, operationKinds, capabilities, onSelectOperation, onCloseOperation }: {
  readonly operations: readonly OperationNode[];
  readonly activeOperationId: string | null;
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationRuntimeHydration: OperationRuntimeHydration;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onSelectOperation: (operationId: string | null) => void;
  readonly onCloseOperation: (operationId: string) => void;
}) {
  const destination = useMobileDestination();
  const consoleState = useConsoleState();
  const [selectedOperationId, setSelectedOperationId] = useState(() => readMobileOperationId());
  const selectedOperation = operations.find((operation) => operation.id === selectedOperationId) ?? null;
  // 지휘관 화면은 고른 구성원의 본문을 보인다 — 데스크톱 지휘관 패널과 같은 원천(코어의 부모 관계 + 본문 선택)이다.
  const chosenBody = selectedOperation ? consoleState.nestedBodySelection[selectedOperation.id] : undefined;
  const bodyNode = chosenBody && selectedOperation
    ? consoleState.nestedOperations.find((candidate) => candidate.id === chosenBody && candidate.parentOperationId === selectedOperation.id) ?? null
    : null;

  useEffect(() => {
    const onPopState = () => {
      const operationId = readMobileOperationId();
      setSelectedOperationId(operationId);
      onSelectOperation(operationId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onSelectOperation]);

  // 주소의 `?op=`가 없는 Operation을 가리키면 목록으로 돌린다 — 단 Operation 목록이 아직 오기 전이면 새로고침이 보던 대화를 잃지 않게 기다린다.
  const operationsHydrated = consoleState.operationsHydrated;
  useEffect(() => {
    if (selectedOperationId === null || selectedOperation || !operationsHydrated) return;
    replaceMobileOperationId(null);
    setSelectedOperationId(null);
    onSelectOperation(null);
  }, [onSelectOperation, operationsHydrated, selectedOperation, selectedOperationId]);

  useEffect(() => {
    if (!selectedOperation) return;
    onSelectOperation(selectedOperation.id);
  }, [onSelectOperation, selectedOperation]);

  // 열린 Operation은 데스크톱 대화 칸의 주인과 같은 자리(`conversation-slots`)에 선다 — 구성원 탭 같은 대화 탭(대화 정보 화면이 읽는다)이
  // 이 주인과 묶음을 읽는다.
  const clusters = useOperationClusters();
  useEffect(() => { publishConversationClusters(clusters); }, [clusters]);
  useEffect(() => { publishConversationSubject(selectedOperation); }, [selectedOperation]);
  useEffect(() => () => publishConversationSubject(null), []);

  const closeOperation = (operationId: string) => {
    // Leave the session immediately so Close is not stuck on a disposing terminal, then
    // dispose through the same host path the canvas and palette already use.
    // 보관 뒤에는 대화 목록으로 돌아간다 — 홈이 목록이라 다음 Operation을 대신 열지 않는다.
    // 정보 화면에서 보관해도 대화 목록(홈)으로 돌아간다.
    if (destination.kind === "info") setMobileDestination({ kind: "home" });
    replaceMobileOperationId(null);
    setSelectedOperationId(null);
    onSelectOperation(null);
    onCloseOperation(operationId);
  };

  let content;
  if (destination.kind === "attention") {
    content = <MobileAttentionScreen />;
  } else if (destination.kind === "archive") {
    content = <MobileArchiveScreen state={consoleState} />;
  } else if (destination.kind === "search") {
    content = <MobileSearchScreen state={consoleState} scope={destination.scope} onBack={() => setMobileDestination(destination.scope === "archive" ? { kind: "archive" } : { kind: "home" })} />;
  } else if (destination.kind === "plugins") {
    content = <MobileTools theme={theme} language={language} />;
  } else if (destination.kind === "plugin") {
    content = <MobilePluginScreen entryId={destination.entryId} theme={theme} language={language} />;
  } else if (selectedOperation) {
    const infoOpen = destination.kind === "info";
    content = (
      <>
        <MobileSessionView
          operation={selectedOperation}
          theme={theme}
          language={language}
          operationKinds={operationKinds}
          capabilities={capabilities}
          active={activeOperationId === selectedOperation.id}
          runtimeState={pluginRuntimeState(operationRuntime, operationRuntimeHydration, selectedOperation.id)}
          operationRuntime={operationRuntime}
          onActivate={() => onSelectOperation(selectedOperation.id)}
          onClose={() => closeOperation(selectedOperation.id)}
          bodyOperation={bodyNode ? { operation: bodyNode, runtimeState: pluginRuntimeState(operationRuntime, operationRuntimeHydration, bodyNode.id), onClose: () => selectNestedBody(selectedOperation.id, null) } : null}
          covered={infoOpen}
        />
        {/* 대화 정보는 대화 화면 위에 선다 — 아래 본문은 내려가지 않아 PTY 크기와 ⋮ 항목이 그대로다. */}
        {infoOpen ? <MobileConversationInfo operation={selectedOperation} bodyOwner={bodyNode ?? selectedOperation} onArchive={() => { rememberArchivedTitle(selectedOperation.id, selectedOperation.title); closeOperation(selectedOperation.id); }} /> : null}
      </>
    );
  } else {
    content = consoleState.theaters.length > 0 ? <MobileConversationList state={consoleState} /> : <MobileEmptyHome />;
  }

  return (
    <main className="mobile-shell">
      <div className="mobile-shell-content">{content}</div>
    </main>
  );
}

/**
 * Theater가 하나도 없을 때의 홈 — 첫 실행 화면(S-49, 상단 막대 없음). 아직 부트스트랩 전이면 빈 화면이다.
 * Theater가 있으면 홈은 대화 목록이다(`MobileConversationList`).
 */
function MobileEmptyHome() {
  const t = useT();
  const state = useConsoleState();
  const firstRun = state.bootstrapped && state.theaters.length === 0;
  useClaimMobileBar({ variant: "centered", title: "", leading: "menu", hidden: true });
  if (!firstRun) return null;
  return (
    <section className="mobile-first-run">
      <span className="mobile-wordmark">Fleet</span>
      <p className="mobile-first-run-lead">{t("mobile.firstRun.lead1")}<br />{t("mobile.firstRun.lead2")}</p>
      <div className="mobile-group is-flush">
        {([["folder", "mobile.firstRun.step1", "mobile.firstRun.step1Sub"], ["newop", "mobile.firstRun.step2", "mobile.firstRun.step2Sub"], ["menu", "mobile.firstRun.step3", "mobile.firstRun.step3Sub"]] as const).map(([icon, title, sub]) => (
          <div className="mobile-group-row is-two" key={title}>
            <span className="mobile-group-row-icon"><MobileIcon name={icon} /></span>
            <span className="mobile-group-row-copy">{t(title)}<small>{t(sub)}</small></span>
          </div>
        ))}
      </div>
      <button type="button" className="mobile-pill" onClick={() => pushMobileSheet({ kind: "folder" })}><MobileIcon name="plus" size={18} />{t("mobile.sheet.theater.add")}</button>
    </section>
  );
}
