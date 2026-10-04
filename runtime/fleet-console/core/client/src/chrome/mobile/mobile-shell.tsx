import { pluginRuntimeState } from "../../../../../features/execution/client/operation-activity.js";
import { useEffect, useRef, useState } from "react";

import type { ConsoleTheme, OperationKindDescriptor, OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import type { createHostCapabilities } from "../../integration/plugin-capabilities.js";

import { useT } from "../../i18n/index.js";
import { openQuickLaunch } from "../../integration/store.js";
import type { OperationNode, OperationNotification } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobilePluginScreen } from "./mobile-plugin-screen.js";
import { MobileSessionView } from "./mobile-session-view.js";
import { MobileTools } from "./mobile-tools.js";
import { useMobileDestination } from "./mobile-store.js";
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

/** Operation이 열려 있지 않을 때의 홈 — 상단 막대에는 지금 Theater 이름이 서고, 본문은 시작을 권한다. */
function MobileEmptyHome({ theaterLabel, hasOperations }: { readonly theaterLabel: string | null; readonly hasOperations: boolean }) {
  const t = useT();
  useClaimMobileBar({ variant: "centered", title: theaterLabel ?? "Fleet", leading: "menu" });
  return (
    <section className="mobile-empty-home">
      <p>{theaterLabel === null ? t("mobile.home.noTheater") : hasOperations ? t("mobile.home.pick") : t("mobile.operations.empty")}</p>
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
