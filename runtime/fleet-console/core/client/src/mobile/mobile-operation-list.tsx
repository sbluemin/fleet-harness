import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { operationActivityVisual, resolveOperationActivity } from "../operation-activity.js";
import type { OperationNode } from "../types.js";

const STATUS_ORDER: readonly OperationActivity[] = ["awaiting", "running", "background", "idle", "dormant"];

export function MobileOperationList({ operations, operationStatus, notificationIds, onOpen }: {
  readonly operations: readonly OperationNode[];
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly notificationIds: ReadonlySet<string>;
  readonly onOpen: (operationId: string) => void;
}) {
  const t = useT();
  const sections = STATUS_ORDER.map((status) => ({
    status,
    entries: operations.filter((operation) => resolveOperationActivity(operation, operationStatus) === status),
  })).filter(({ entries }) => entries.length > 0);
  return (
    <section className="mobile-operation-list" aria-labelledby="mobile-operation-list-title">
      <header className="mobile-list-header">
        <div>
          <span className="mobile-kicker">{t("mobile.operations.kicker")}</span>
          <h1 id="mobile-operation-list-title">{t("mobile.operations.title")}</h1>
        </div>
        <span className="mobile-total-count">{operations.length}</span>
      </header>
      <div className="mobile-status-sections">
        {sections.length === 0 ? (
          <p className="mobile-operation-empty">{t("mobile.operations.empty")}</p>
        ) : sections.map(({ status, entries }) => (
          <section className="mobile-status-section" key={status} aria-labelledby={`mobile-status-${status}`}>
            <header>
              <h2 id={`mobile-status-${status}`}>{t(`mobile.status.${status}`)}</h2>
              <span>{entries.length}</span>
            </header>
            <div className="mobile-operation-cards">
              {entries.map((operation) => {
                const cliLabel = typeof operation.payload.cliLabel === "string" && operation.payload.cliLabel.trim()
                  ? operation.payload.cliLabel.trim()
                  : null;
                return (
                  <button type="button" className="mobile-operation-card" key={operation.id} onClick={() => onOpen(operation.id)}>
                    <span className={beaconClass(status)} aria-hidden="true" />
                    <span className="mobile-operation-card-copy">
                      <strong>{operation.title}</strong>
                      {cliLabel ? <span>{cliLabel}</span> : null}
                    </span>
                    {notificationIds.has(operation.id) ? <span className="mobile-operation-alert-mark" aria-label={t("mobile.operations.hasAlert")}>!</span> : null}
                    <span className="mobile-operation-chevron" aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function beaconClass(status: OperationActivity): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "tenant-beacon is-turn-running";
  if (visual === "background") return "tenant-beacon is-background";
  if (visual === "awaiting") return "tenant-beacon is-awaiting";
  if (visual === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-idle";
}
