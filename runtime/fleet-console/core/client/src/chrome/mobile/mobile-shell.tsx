import { pluginRuntimeState } from "../../../../../features/execution/client/operation-activity.js";
import { useEffect, useRef, useState } from "react";

import type { ConsoleTheme, OperationKindDescriptor, OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";

import { useT } from "../../i18n/index.js";
import { openQuickLaunch } from "../../integration/store.js";
import type { OperationNode, OperationNotification } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { MobilePluginScreen } from "./mobile-plugin-screen.js";
import { MobileSessionView } from "./mobile-session-view.js";
import { MobileTools } from "./mobile-tools.js";
import { pushMobileSheet, setMobileDestination, useMobileDestination } from "./mobile-store.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { MobileArchiveScreen } from "./mobile-archive-screen.js";
import { MobileSearchScreen } from "./mobile-search-screen.js";
import { MobileAttentionScreen } from "./mobile-attention-screen.js";
import "../../styles/mobile.css";

const LAST_OPERATION_KEY = "fleet-console.mobile.lastOperation";

/**
 * `/operations` 안의 화면. 어떤 화면이 서는지는 드로어가 고른 목적지가 정한다 — Operation(홈), 확인 필요, 플러그인 목록,
 * 플러그인이 올린 목적지. 열린 Operation은 `?op=` 한 곳이 가리키고, 다른 목적지로 갔다 돌아와도 그 자리에 그대로 있다.
 */
export function MobileShell({ operations, activeOperationId, operationRuntime, operationRuntimeHydration, operationNotifications: _operationNotifications, theaterLabel, theme, language, operationKinds, capabilities, onSelectOperation, onCloseOperation }: {
  readonly operations: readonly OperationNode[];
  readonly activeOperationId: string | null;
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationRuntimeHydration: OperationRuntimeHydration;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly theaterLabel: string | null;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onSelectOperation: (operationId: string | null) => void;
  readonly onCloseOperation: (operationId: string) => void;
}) {
  const destination = useMobileDestination();
  const consoleState = useConsoleState();
  const [selectedOperationId, setSelectedOperationId] = useState(() => readOperationId());
  const selectedOperation = operations.find((operation) => operation.id === selectedOperationId) ?? null;
  const restoredRef = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      const operationId = readOperationId();
      setSelectedOperationId(operationId);
      onSelectOperation(operationId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onSelectOperation]);

  useEffect(() => {
    if (selectedOperationId === null || selectedOperation) return;
    replaceOperationId(null);
    setSelectedOperationId(null);
    onSelectOperation(null);
  }, [onSelectOperation, selectedOperation, selectedOperationId]);

  useEffect(() => {
    if (!selectedOperation) return;
    onSelectOperation(selectedOperation.id);
    writeLastOperation(selectedOperation.id);
  }, [onSelectOperation, selectedOperation]);

  // 첫 화면은 마지막으로 보던 작업이다 — `?op=`가 없고 저장된 작업이 지금 Theater에 살아 있으면 그리로 들어간다.
  useEffect(() => {
    if (restoredRef.current || selectedOperationId !== null || operations.length === 0) return;
    restoredRef.current = true;
    const last = readLastOperation();
    if (last && operations.some((operation) => operation.id === last)) {
      replaceOperationId(last);
      setSelectedOperationId(last);
    }
  }, [operations, selectedOperationId]);

  const closeOperation = (operationId: string) => {
    // Leave the session immediately so Close is not stuck on a disposing terminal, then
    // dispose through the same host path the canvas and palette already use.
    replaceOperationId(null);
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
    content = <MobileSearchScreen state={consoleState} onBack={() => setMobileDestination({ kind: "home" })} />;
  } else if (destination.kind === "plugins") {
    content = <MobileTools theme={theme} language={language} />;
  } else if (destination.kind === "plugin") {
    content = <MobilePluginScreen entryId={destination.entryId} theme={theme} language={language} />;
  } else if (selectedOperation) {
    content = (
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
      />
    );
  } else {
    content = <MobileEmptyHome theaterLabel={theaterLabel} hasOperations={operations.length > 0} />;
  }

  return (
    <main className="mobile-shell">
      <div className="mobile-shell-content">{content}</div>
    </main>
  );
}

/**
 * Operation이 열려 있지 않을 때의 홈. Theater가 없으면 첫 실행 화면(S-49, 상단 막대 없음), Theater는 있는데 작업이 없으면 빈 홈(S-37),
 * 작업은 있는데 열린 것이 없으면 고르라는 안내.
 */
function MobileEmptyHome({ theaterLabel, hasOperations }: { readonly theaterLabel: string | null; readonly hasOperations: boolean }) {
  const t = useT();
  const state = useConsoleState();
  const theater = state.theaters.find((item) => item.id === state.activeTheaterId) ?? null;
  const firstRun = state.bootstrapped && state.theaters.length === 0;
  useClaimMobileBar(firstRun
    ? { variant: "centered", title: "", leading: "menu", hidden: true }
    : { variant: "centered", title: "", leading: "menu" });

  if (firstRun) {
    return (
      <section className="mobile-first-run">
        <span className="mobile-wordmark">Fleet</span>
        <p className="mobile-first-run-lead">{t("mobile.firstRun.lead")}</p>
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
  return (
    <section className="mobile-empty-home">
      {theater ? <MobileMonogram label={theater.label} toneKey={theater.id} size={56} /> : null}
      {theaterLabel ? <strong className="mobile-empty-home-name">{theaterLabel}</strong> : null}
      <p>{theaterLabel === null ? t("mobile.home.noTheater") : hasOperations ? t("mobile.home.pick") : t("mobile.home.emptyTheater")}</p>
      {theaterLabel !== null ? (
        <button type="button" className="mobile-pill" onClick={openQuickLaunch}><MobileIcon name="plus" size={18} />{t("mobile.drawer.newOperation")}</button>
      ) : null}
    </section>
  );
}

function readOperationId(): string | null {
  return new URL(window.location.href).searchParams.get("op");
}

function replaceOperationId(operationId: string | null): void {
  const url = new URL(window.location.href);
  if (operationId) url.searchParams.set("op", operationId);
  else url.searchParams.delete("op");
  window.history.replaceState({ ...window.history.state, fleetMobileOperation: false }, "", url);
}

function readLastOperation(): string | null {
  try { return localStorage.getItem(LAST_OPERATION_KEY); } catch { return null; }
}

function writeLastOperation(operationId: string): void {
  try { localStorage.setItem(LAST_OPERATION_KEY, operationId); } catch { /* storage is optional */ }
}
