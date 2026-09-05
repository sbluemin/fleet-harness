import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { AgentId, Scope, SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { AGENT_LABELS, InstallFlow } from "./install-flow.js";
import { MarkdownView } from "./markdown-view.js";
import { JobStatusDock } from "./skill-feedback.js";
import type { UseJobLogReturn } from "./use-job-log.js";

interface ReadingOverlayProps {
  readonly skill: SkillListItem;
  readonly isInstalled: boolean;
  readonly theaterId: string | null;
  readonly onClose: () => void;
  readonly onInstall: (scope: Scope, agents: AgentId[]) => void;
  readonly onRemoved: () => void;
  readonly installLog: UseJobLogReturn;
  readonly t: Translate<SkillsMessageKey>;
  readonly language: ConsoleLocale | undefined;
}

const FOCUSABLE_SELECTOR = "a[href],button:not([disabled]),input:not([disabled]),summary,[tabindex]:not([tabindex='-1'])";

export function ReadingOverlay({ skill, isInstalled, theaterId, onClose, onInstall, onRemoved, installLog, t, language }: ReadingOverlayProps) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(true);
  const removingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setMarkdown(null);
    void (async () => {
      try {
        const body = isInstalled
          ? { scope: skill.scope, skill: skill.name, ...(skill.scope === "project" ? { theaterId } : {}) }
          : { source: skill.source, skill: skill.name, theaterId };
        const res = await fetch(isInstalled ? "/plugins/skills/installed-file" : "/plugins/skills/preview", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
        });
        if (!res.ok) throw new Error("preview_failed");
        const data = await res.json() as { markdown: string };
        if (!controller.signal.aborted) setMarkdown(data.markdown ?? "");
      } catch {
        // 실패는 본문에 재시도 동작과 함께 남긴다.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [skill, isInstalled, theaterId, retryKey]);

  useEffect(() => {
    const returnTarget = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
          .filter((element) => element.getClientRects().length > 0 && !element.matches(":disabled"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      } else if (event.repeat && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (installOpen) dialogRef.current?.querySelector<HTMLInputElement>(".skills-install-flow input:not(:disabled)")?.focus();
  }, [installOpen]);

  useEffect(() => {
    if (!removeArmed) return;
    const timer = setTimeout(() => setRemoveArmed(false), 2600);
    return () => clearTimeout(timer);
  }, [removeArmed]);

  const remove = async () => {
    if (removingRef.current) return;
    if (!removeArmed) { setRemoveArmed(true); return; }
    setRemoveArmed(false);
    removingRef.current = true;
    setRemoving(true);
    setRemoveFailed(false);
    try {
      const res = await fetch("/plugins/skills/remove", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: skill.scope, skill: skill.name, ...(skill.scope === "project" ? { theaterId } : {}) }),
      });
      if (!res.ok) throw new Error("remove_failed");
      onRemoved();
    } catch {
      if (aliveRef.current) setRemoveFailed(true);
    } finally {
      removingRef.current = false;
      if (aliveRef.current) setRemoving(false);
    }
  };

  const source = skill.source ?? (skill.unmanaged ? t("skills.card.local") : null);
  return createPortal(
    <div className="skills-overlay-backdrop" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("skills.overlay.skillMdAria", { name: skill.name })}
        className="skills-overlay-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="skills-overlay-header">
          <div className="skills-overlay-heading"><span className="skills-overlay-title">{skill.name}</span>
            {source && <span className="skills-overlay-meta">{source}</span>}
          </div>
          <button ref={closeButtonRef} type="button" className="skills-overlay-close" onClick={onClose} aria-label={t("skills.overlay.close")}>✕</button>
        </div>
        <div className="skills-overlay-body">
          {skill.description && <p className="skills-detail-description">{skill.description}</p>}
          <dl className="skills-detail-facts">
            <dt>{t("skills.detail.status")}</dt><dd>{t(isInstalled ? "skills.status.installed" : "skills.detail.notInstalled")}</dd>
            <dt>{t("skills.scope.label")}</dt><dd>{isInstalled ? t(skill.scope === "project" ? "skills.scope.projectHint" : "skills.scope.globalHint") : t("skills.detail.chooseAtInstall")}</dd>
            {isInstalled && <><dt>{t("skills.install.agents")}</dt><dd>{skill.agents.map((agent) => AGENT_LABELS[agent as AgentId] ?? agent).join(", ") || t("skills.detail.agentsUnknown")}</dd></>}
          </dl>
          <details className="skills-detail-document" open={!installOpen}>
            <summary>{t("skills.action.readSkillMd")}</summary>
            {loading && <div className="skills-empty-state" role="status">{t("skills.overlay.loading")}</div>}
            {!loading && markdown === null && <div className="skills-empty-state"><p>{t("skills.overlay.loadFailed")}</p>
              <button type="button" className="skills-btn skills-btn--ghost" onClick={() => setRetryKey((key) => key + 1)}>{t("skills.action.retry")}</button></div>}
            {markdown !== null && <MarkdownView content={markdown} language={language} />}
          </details>
          {!isInstalled && installOpen && <InstallFlow theaterId={theaterId} onInstall={onInstall} disabled={installLog.status === "running"}
            onCancel={() => { setInstallOpen(false); requestAnimationFrame(() => installButtonRef.current?.focus()); }} t={t} />}
          {removeFailed && <FailureNotice title={t("skills.failure.remove.title")} cause={t("skills.failure.remove.cause")} tone="coral" />}
        </div>
        {(isInstalled || !installOpen) && <div className="skills-overlay-footer">
          <p className="skills-permission-warning">{t("skills.overlay.permissionWarning")}</p>
          {isInstalled ? <button type="button" disabled={removing} className={`skills-btn skills-btn--remove${removeArmed ? " is-armed" : ""}`}
            onClick={() => { void remove(); }} aria-label={t(removeArmed ? "skills.action.removeConfirmAria" : "skills.action.removeAria", { name: skill.name })}>
            {t(removing ? "skills.action.removing" : removeArmed ? "skills.action.removeConfirm" : "skills.action.remove")}
          </button> : !installOpen && <button ref={installButtonRef} type="button" className="skills-btn skills-btn--primary"
            disabled={installLog.status === "running"} onClick={() => setInstallOpen(true)}>{t("skills.install.settings")}</button>}
        </div>}
        {!isInstalled && <JobStatusDock status={installLog.status} lines={installLog.lines} runningLabel={t("skills.status.installing")}
          doneLabel={t("skills.status.installed")} errorLabel={t("skills.status.installFailed")} onDismiss={installLog.reset} t={t} />}
      </div>
    </div>, document.body,
  );
}
