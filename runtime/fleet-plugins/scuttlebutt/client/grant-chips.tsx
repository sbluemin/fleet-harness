import { createPortal } from "react-dom";

import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "./scuttlebutt-catalog.js";
import type { AideGrants } from "./settings-store.js";

/**
 * 권한 칩 줄 — 이 부관이 지금 무엇을 할 수 있는지를 기능 이름이 아니라 권한으로 말한다.
 *
 * 「웹 전용」「콘솔 사용」은 기능 이름이지 권한이 아니었다: 조회인지 지시인지, 파일은 되는지 말하지
 * 않는다. 칩은 항상 서는 「웹 읽기」와 「파일·셸 없음」 사이에 허용된 확장만 세우고, 칩에 머무르면
 * 실제 동사와 조건이 한 줄 말풍선으로 선다(헤더 아이콘의 도움말과 같은 계약·같은 포털).
 * 글리프는 Operation 메뉴·사이드바 칩의 ~Use 글리프 그대로다.
 */
export function GrantLine({ grants, locale, compact = false }: {
  readonly grants: AideGrants;
  readonly locale: ConsoleLocale | undefined;
  /** 말풍선 머리처럼 좁은 자리 — 「권한」 라벨과 「파일·셸 없음」을 접고 허용된 것만 세운다. */
  readonly compact?: boolean;
}) {
  const t = getT(locale);
  return (
    <span className={`scuttlebutt-grants${compact ? " is-compact" : ""}`} role="group" aria-label={t("grant.label")}>
      {!compact ? <span className="scuttlebutt-grants-label">{t("grant.label")}</span> : null}
      <GrantChip label={t("grant.web")} tip={t("grant.web.tip")} icon={<WebGlyph />} />
      {grants.consoleUse ? <GrantChip granted label={t("grant.console")} tip={t("grant.console.tip")} icon={<CaptionConsoleUseGlyph />} /> : null}
      {grants.computerUse ? <GrantChip granted label={t("grant.computer")} tip={t("grant.computer.tip")} icon={<CaptionComputerUseGlyph />} /> : null}
      {!compact ? <GrantChip label={t("grant.noFs")} tip={t("grant.noFs.tip")} icon={<NoFsGlyph />} /> : null}
    </span>
  );
}

function GrantChip({ label, tip, icon, granted = false }: {
  readonly label: string;
  readonly tip: string;
  readonly icon: React.ReactNode;
  readonly granted?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = React.useState<{ readonly top: number; readonly left: number } | null>(null);
  const id = React.useId();
  React.useLayoutEffect(() => {
    if (!open) return;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)) });
  }, [open]);
  return (
    <span
      ref={ref}
      className={`scuttlebutt-grant${granted ? " is-granted" : ""}`}
      tabIndex={0}
      role="img"
      aria-label={`${label} — ${tip}`}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className="scuttlebutt-grant-glyph" aria-hidden="true">{icon}</span>
      {label}
      {createPortal(
        <span
          className="scuttlebutt-head-tip"
          role="tooltip"
          id={id}
          hidden={!open || anchor === null}
          style={anchor ? { top: anchor.top, left: anchor.left, right: "auto" } : undefined}
        >
          <b>{label}</b>
          {tip}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** 헤더 이름 옆의 12px 글리프 pill — 켜진 확장만, Operation 사이드바 칩의 표식과 같은 문법. */
export function GrantMarks({ grants, locale }: { readonly grants: AideGrants; readonly locale: ConsoleLocale | undefined }) {
  const t = getT(locale);
  if (!grants.consoleUse && !grants.computerUse) return null;
  const names = [grants.consoleUse ? t("menu.consoleUse") : null, grants.computerUse ? t("menu.computerUse") : null].filter((name) => name !== null);
  return (
    <span className="scuttlebutt-grant-marks" role="img" aria-label={names.join(", ")}>
      {grants.consoleUse ? <span className="scuttlebutt-grant-mark" title={t("menu.consoleUse")}><CaptionConsoleUseGlyph /></span> : null}
      {grants.computerUse ? <span className="scuttlebutt-grant-mark" title={t("menu.computerUse")}><CaptionComputerUseGlyph /></span> : null}
    </span>
  );
}

/** 인사말에 붙는 「지금 이 대화에서 … 맡습니다」의 목적어. 허용이 없으면 null. */
export function grantSummary(grants: AideGrants, locale: ConsoleLocale | undefined): string | null {
  const t = getT(locale);
  const parts = [grants.consoleUse ? t("grant.console") : null, grants.computerUse ? t("grant.computer") : null].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(locale === "ko" ? "과 " : " and ");
}

/** Quick Launch 덱 행의 짧은 권한 문구 — 칩 글자를 점으로 잇는다. */
export function grantCapabilityLabel(grants: AideGrants, locale: ConsoleLocale | undefined): string {
  const t = getT(locale);
  return [t("grant.web"), grants.consoleUse ? t("grant.console") : null, grants.computerUse ? t("grant.computer") : null]
    .filter((part) => part !== null)
    .join(" · ");
}

/** 덱 행의 설명 문장 — 하는 일을 열거하고 파일·셸이 없다는 사실로 끝난다. */
export function grantDescription(name: string, grants: AideGrants, locale: ConsoleLocale | undefined): string {
  const t = getT(locale);
  const parts = [
    t("mention.description.base", { name }),
    grants.consoleUse ? t("mention.description.console") : null,
    grants.computerUse ? t("mention.description.computer") : null,
  ].filter((part) => part !== null);
  return `${parts.join(", ")}. ${t("mention.description.tail")}`;
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function WebGlyph() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" {...STROKE}>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M1.5 6h9M6 1.5c-2 2.2-2 6.8 0 9M6 1.5c2 2.2 2 6.8 0 9" />
    </svg>
  );
}

function NoFsGlyph() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" {...STROKE}>
      <path d="M2 2.5h4l1 1.5h3v5.5H2z" />
      <path d="M2 2l8 8" strokeWidth="1.4" />
    </svg>
  );
}
