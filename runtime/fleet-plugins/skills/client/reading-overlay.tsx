import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { MarkdownView } from "./markdown-view.js";

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
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (skill && returnFocusRef.current === null) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
    }
  }, [skill]);

  useEffect(() => {
    if (!skill) {
      setMarkdown(null);
      return;
    }
    setLoading(true);
    setMarkdown(null);
    let cancelled = false;

    const load = async () => {
      try {
        let res: Response;
        if (isInstalled) {
          const body: Record<string, unknown> = { scope: skill.scope, skill: skill.name };
          if (skill.scope === "project" && theaterId) {
            body["theaterId"] = theaterId;
          }
          res = await fetch("/plugins/skills/installed-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } else {
          res = await fetch("/plugins/skills/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: skill.source, skill: skill.name, theaterId }),
          });
        }
        if (cancelled) return;
        if (!res.ok) { setLoading(false); return; }
        const data = await res.json() as { markdown: string };
        if (!cancelled) {
          setMarkdown(data.markdown ?? "");
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [skill, isInstalled, theaterId]);

  useEffect(() => {
    if (!skill) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        trapFocus(event, dialogRef.current);
      }
      event.stopImmediatePropagation();
    };

    closeButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
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
        aria-label={t("skills.overlay.skillMdAria", { name: skill.name })}
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
          {loading && (
            <div className="skills-empty-state">{t("skills.overlay.loading")}</div>
          )}
          {!loading && markdown === null && (
            <div className="skills-empty-state">{t("skills.overlay.loadFailed")}</div>
          )}
          {markdown !== null && <MarkdownView content={markdown} language={language} />}
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
