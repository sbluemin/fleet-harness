import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { MarkdownView } from "./markdown-view.js";
import { PackageAtlas } from "./package-atlas.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface ReadingOverlayProps {
  readonly skill: SkillListItem | null;
  readonly isInstalled: boolean;
  readonly theaterId: string | null;
  readonly onClose: () => void;
  readonly onInstall: () => void;
  readonly t: Translate<SkillsMessageKey>;
  readonly language: ConsoleLocale | undefined;
}

// ─── constants ───────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// ─── helpers ─────────────────────────────────────────────────────────────────

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ─── ReadingOverlay ───────────────────────────────────────────────────────────

export function ReadingOverlay({
  skill,
  isInstalled,
  theaterId,
  onClose,
  onInstall,
  t,
  language,
}: ReadingOverlayProps) {
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewRequestKey, setPreviewRequestKey] = useState(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (skill && returnFocusRef.current === null) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
    }
  }, [skill]);

  useEffect(() => {
    if (!skill || isInstalled) {
      setPreviewMarkdown(null);
      setPreviewFailed(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewFailed(false);
    setPreviewMarkdown(null);
    const abort = new AbortController();
    void fetch("/plugins/skills/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: skill.source, skill: skill.name, theaterId }),
      signal: abort.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { markdown: string };
      setPreviewMarkdown(data.markdown ?? "");
    }).catch(() => {
      if (!abort.signal.aborted) setPreviewFailed(true);
    }).finally(() => {
      if (!abort.signal.aborted) setPreviewLoading(false);
    });
    return () => abort.abort();
  }, [skill, isInstalled, previewRequestKey, theaterId]);

  useEffect(() => {
    if (!skill) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === "Tab") {
        trapFocus(event, dialogRef.current);
        event.stopImmediatePropagation();
      }
    };

    const appShell = document.querySelector<HTMLElement>(".console-shell");
    const previousInert = appShell?.inert ?? false;
    if (appShell) appShell.inert = true;
    closeButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (appShell) appShell.inert = previousInert;
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [skill, onClose]);

  useEffect(() => {
    if (!skill) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [skill]);

  if (!skill) return null;

  const metaText = skill.displayPath || skill.source || null;

  return createPortal(
    // 백드롭에 aria-hidden을 두면 그 안의 다이얼로그까지 접근성 트리에서 사라진다 — 시각적으로
    // 열려 있는 창의 닫기·복사 버튼이 보조기술에는 존재하지 않게 된다. 배경은 클릭 대상일 뿐이라
    // 숨길 것이 없다.
    <div
      className="skills-overlay-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(isInstalled ? "skills.overlay.packageAria" : "skills.overlay.skillMdAria", { name: skill.name })}
        className="skills-overlay-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skills-overlay-header">
          <span className="skills-overlay-title">{skill.name}</span>
          {metaText && (
            <span className="skills-overlay-meta">{metaText}</span>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="skills-overlay-close"
            onClick={onClose}
            aria-label={t("skills.overlay.close")}
          >
            ✕
          </button>
        </div>
        <div className="skills-overlay-body">
          {isInstalled ? (
            <PackageAtlas skill={skill} theaterId={theaterId} t={t} language={language} />
          ) : (
            <>
              {previewLoading ? <div className="skills-empty-state" role="status">{t("skills.overlay.loading")}</div> : null}
              {previewFailed ? (
                <div className="skills-overlay-preview-failure">
                  <p>{t("skills.overlay.loadFailed")}</p>
                  <button type="button" className="skills-btn skills-btn--primary" onClick={() => setPreviewRequestKey((key) => key + 1)}>
                    {t("skills.action.retry")}
                  </button>
                </div>
              ) : null}
              {previewMarkdown !== null ? <MarkdownView content={previewMarkdown} language={language} /> : null}
            </>
          )}
        </div>
        <div className="skills-overlay-footer">
          <p className="skills-permission-warning">{t("skills.overlay.permissionWarning")}</p>
          {!isInstalled && (
            <button
              type="button"
              className="skills-btn skills-btn--primary"
              onClick={() => { onClose(); onInstall(); }}
            >
              {t("skills.action.install")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
