import { useEffect, useMemo, useState } from "react";

import type { ConsoleTheme, OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import type { OperationNode, OperationNotification } from "../types.js";
import { MobileOperationList } from "./mobile-operation-list.js";
import { MobileSessionView } from "./mobile-session-view.js";
import { useMobileTab } from "./mobile-store.js";
import { MobileTabBar } from "./mobile-tab-bar.js";
import "../styles/mobile.css";

export function MobileShell({ operations, activeOperationId, operationStatus, operationNotifications, theme, language, onSelectOperation, onCloseOperation }: {
  readonly operations: readonly OperationNode[];
  readonly activeOperationId: string | null;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
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

  const openOperation = (operationId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("op", operationId);
    window.history.pushState({ ...window.history.state, fleetMobileOperation: true }, "", url);
    setSelectedOperationId(operationId);
    onSelectOperation(operationId);
  };
  const closeSession = () => {
    if (window.history.state?.fleetMobileOperation === true) window.history.back();
    else {
      replaceOperationId(null);
      setSelectedOperationId(null);
      onSelectOperation(null);
    }
  };

  let content;
  if (selectedOperation) {
    content = (
      <MobileSessionView
        operation={selectedOperation}
        theme={theme}
        language={language}
        active={activeOperationId === selectedOperation.id}
        onActivate={() => onSelectOperation(selectedOperation.id)}
        onBack={closeSession}
        onClose={() => {
          onCloseOperation(selectedOperation.id);
          replaceOperationId(null);
          setSelectedOperationId(null);
        }}
      />
    );
  } else if (activeTab === "operations") {
    content = <MobileOperationList operations={operations} operationStatus={operationStatus} notificationIds={notificationIds} onOpen={openOperation} />;
  } else if (activeTab === "alerts") {
    content = (
      <section className="mobile-simple-panel">
        <h1>{t("mobile.alerts.title")}</h1>
        {notificationIds.size === 0 ? <p>{t("mobile.alerts.empty")}</p> : operations.filter((operation) => notificationIds.has(operation.id)).map((operation) => (
          <button type="button" key={operation.id} onClick={() => openOperation(operation.id)}>{operation.title}</button>
        ))}
      </section>
    );
  } else {
    content = <section className="mobile-simple-panel"><h1>{t("mobile.tools.title")}</h1><p>{t("mobile.tools.empty")}</p></section>;
  }

  return (
    <main className="mobile-shell">
      <div className="mobile-shell-content">{content}</div>
      <MobileTabBar onSelect={() => {
        if (selectedOperationId === null) return;
        replaceOperationId(null);
        setSelectedOperationId(null);
        onSelectOperation(null);
      }} />
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
