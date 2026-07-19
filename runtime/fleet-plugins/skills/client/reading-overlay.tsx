import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { SkillListItem } from "../server/types.js";
import { MarkdownView } from "./markdown-view.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface ReadingOverlayProps {
  readonly skill: SkillListItem | null;
  readonly isInstalled: boolean;
  readonly theaterId: string | null;
  readonly onClose: () => void;
  readonly onInstall: () => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const PERMISSION_WARNING =
  "Skills run with full agent permissions. Review before use.";

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
    <div
      className="skills-overlay-backdrop"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${skill.name} SKILL.md`}
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
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="skills-overlay-body">
          {loading && (
            <div className="skills-empty-state">Loading SKILL.md…</div>
          )}
          {!loading && markdown === null && (
            <div className="skills-empty-state">Could not load SKILL.md.</div>
          )}
          {markdown !== null && <MarkdownView content={markdown} />}
        </div>
        <div className="skills-overlay-footer">
          <p className="skills-permission-warning">{PERMISSION_WARNING}</p>
          {!isInstalled && (
            <button
              type="button"
              className="skills-btn skills-btn--primary"
              onClick={() => { onClose(); onInstall(); }}
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
