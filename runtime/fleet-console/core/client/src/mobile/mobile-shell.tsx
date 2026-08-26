import { pluginRuntimeState } from "../operation-activity.js";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConsoleTheme, OperationKindDescriptor, OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { createHostCapabilities } from "../plugin-capabilities.js";

import { useT } from "../i18n/index.js";
import type { OperationNode, OperationNotification } from "../types.js";
import { MobileOperationList } from "./mobile-operation-list.js";
import { MobileSessionView } from "./mobile-session-view.js";
import { setMobileSessionOpen, useMobileTab } from "./mobile-store.js";
import "../styles/mobile.css";

export function MobileShell({ operations, activeOperationId, operationRuntime, operationRuntimeHydration, operationNotifications, theaterLabel, theme, language, operationKinds, railPanels, railContext, capabilities, onSelectOperation, onCloseOperation }: {
  readonly operations: readonly OperationNode[];
  readonly activeOperationId: string | null;
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationRuntimeHydration: OperationRuntimeHydration;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly theaterLabel: string | null;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly railPanels: readonly RailPanelDescriptor[];
  readonly railContext: RailPanelContext;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onSelectOperation: (operationId: string | null) => void;
  readonly onCloseOperation: (operationId: string) => void;
}) {
  const t = useT();
  const activeTab = useMobileTab();
  const [selectedOperationId, setSelectedOperationId] = useState(() => readOperationId());
  const selectedOperation = operations.find((operation) => operation.id === selectedOperationId) ?? null;
  const notificationIds = useMemo(() => new Set(Object.keys(operationNotifications)), [operationNotifications]);

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
  }, [onSelectOperation, selectedOperation]);

  // An open operation takes the whole layout, so the bar above this shell steps aside for it.
  useEffect(() => {
    setMobileSessionOpen(selectedOperation !== null);
    return () => setMobileSessionOpen(false);
  }, [selectedOperation]);

  // The tab bar lives above this shell, so a tab press is observed here rather than handed down;
  // picking a tab leaves the open operation the same way the bar used to close it directly.
  const previousTabRef = useRef(activeTab);
  useEffect(() => {
    if (previousTabRef.current === activeTab) return;
    previousTabRef.current = activeTab;
    if (selectedOperationId === null) return;
    replaceOperationId(null);
    setSelectedOperationId(null);
    onSelectOperation(null);
  }, [activeTab, onSelectOperation, selectedOperationId]);

  const openOperation = (operationId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("op", operationId);
    window.history.pushState({ ...window.history.state, fleetMobileOperation: true }, "", url);
    setSelectedOperationId(operationId);
    onSelectOperation(operationId);
  };
  const closeOperation = (operationId: string) => {
    // Leave the session immediately so Close is not stuck on a disposing terminal, then
    // dispose through the same host path the canvas and palette already use.
    replaceOperationId(null);
    setSelectedOperationId(null);
    onSelectOperation(null);
    onCloseOperation(operationId);
  };
  let content;
  if (selectedOperation) {
    content = (
      <MobileSessionView
        operation={selectedOperation}
        theme={theme}
        language={language}
        operationKinds={operationKinds}
        capabilities={capabilities}
        active={activeOperationId === selectedOperation.id}
        runtimeState={pluginRuntimeState(operationRuntime, operationRuntimeHydration, selectedOperation.id)}
        onActivate={() => onSelectOperation(selectedOperation.id)}
        onClose={() => closeOperation(selectedOperation.id)}
      />
    );
  } else if (activeTab === "operations") {
    content = <MobileOperationList operations={operations} operationRuntime={operationRuntime} notificationIds={notificationIds} theaterLabel={theaterLabel} onOpen={openOperation} />;
  } else if (activeTab.startsWith("panel:")) {
    const panelId = activeTab.slice("panel:".length);
    const panel = railPanels.find((candidate) => candidate.id === panelId && candidate.render !== undefined);
    content = panel ? (
      <section className="mobile-rail-panel" aria-label={resolveLocalizedText(panel.title, language)}>
        {panel.render?.(railContext)}
      </section>
    ) : null;
  } else {
    content = (
      <section className="mobile-simple-panel">
        <h1>{t("mobile.alerts.title")}</h1>
        {notificationIds.size === 0 ? <p>{t("mobile.alerts.empty")}</p> : operations.filter((operation) => notificationIds.has(operation.id)).map((operation) => (
          <button type="button" key={operation.id} onClick={() => openOperation(operation.id)}>{operation.title}</button>
        ))}
      </section>
    );
  }

  return (
    <main className="mobile-shell">
      <div className="mobile-shell-content">{content}</div>
    </main>
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
