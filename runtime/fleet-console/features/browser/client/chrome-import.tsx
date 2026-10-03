import { React } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";

import type { getT } from "./i18n.js";

/**
 * 「브라우저에서 가져오기」 — Operation 브라우저와 전역 Fleet 브라우저가 함께 쓰는 원본 조회와 대화상자.
 *
 * 원본은 창을 든 Desktop 기계의 Google Chrome 프로필이고, 쿠키는 셸이 읽어 셸이 넣는다(콘솔을 거치지 않는다).
 * 어느 세션에 넣을지는 부르는 쪽이 자기 경로로 정한다 — 이 부품은 고르기와 보여 주기만 맡는다.
 */

type T = ReturnType<typeof getT>;

export interface ChromeImportSources {
  readonly available: boolean;
  readonly reason: "chrome_required" | "no_profiles" | null;
  readonly profiles: readonly { readonly id: string; readonly name: string; readonly account: string | null }[];
}

const glyph = (paths: string) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: paths }} />
);
export const ImportGlyph = () => glyph('<path d="M8 2v8M4.8 6.8 8 10l3.2-3.2"/><path d="M2.5 10.5V12A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"/>');
/* 세션의 정체 — 남는 것은 방패, 사라지는 것은 가림. 두 글리프의 대비가 표식 한 칸에서 읽혀야 한다. */
export const ProfileGlyph = () => glyph('<path d="M8 1.8 13 3.6v4.1c0 3-2 5.2-5 6.5-3-1.3-5-3.5-5-6.5V3.6z"/>');
export const EphemeralGlyph = () => glyph('<path d="M3 7.4 4.4 3.4h7.2L13 7.4"/><path d="M1.8 7.4h12.4"/><circle cx="5" cy="10.4" r="2"/><circle cx="11" cy="10.4" r="2"/><path d="M7 10.4h2"/>');
export const GlobeGlyph = () => glyph('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>');
/** Google Chrome 로고 — 브랜드 색은 브랜드의 것이라 토큰이 아닌 고정값이다. */
const ChromeGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="11" fill="#ffffff" />
    <path d="M12 1a11 11 0 0 1 9.53 5.5H12a5.5 5.5 0 0 0-4.76 2.75L3.47 4.7A11 11 0 0 1 12 1Z" fill="#db4437" />
    <path d="M3.47 4.7 7.24 9.25a5.5 5.5 0 0 0 .96 6.3L4.1 20.1A11 11 0 0 1 3.47 4.7Z" fill="#0f9d58" />
    <path d="M21.94 6.5a11 11 0 0 1-9.98 16.47 11 11 0 0 1-7.86-2.87l4.1-4.55a5.5 5.5 0 0 0 9.3-3.05h4.44Z" fill="#f4b400" />
    <circle cx="12" cy="12" r="4.2" fill="#4285f4" stroke="#ffffff" strokeWidth="1.3" />
  </svg>
);

/** Windows 셸은 Chrome 쿠키 복호화를 아직 하지 않는다 — 두 브라우저가 같은 자리에서 막는다. */
export function chromeImportUnavailable(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.desktopPlatform === "win32";
}

/** 가져올 수 있는 Chrome 프로필을 셸에 묻는다. 고를 것이 없으면 사람에게 보일 까닭 한 줄을 돌려준다. */
export async function loadChromeImportSources(t: T): Promise<{ readonly sources: ChromeImportSources } | { readonly error: string }> {
  try {
    const response = await fetch("/api/v1/browser/import-sources");
    if (!response.ok) return { error: t("terminal.browser.requestFailed") };
    const sources = await response.json() as ChromeImportSources;
    if (!sources.available) return { error: sources.reason === "no_profiles" ? t("terminal.browser.import.noProfiles") : t("terminal.browser.import.chromeRequired") };
    return { sources };
  } catch { return { error: t("terminal.browser.requestFailed") }; }
}

/**
 * 가져오기 대화상자. `aria-modal` 이라 열린 동안 네이티브 뷰가 물러선다(오버레이 레지스트리).
 * `onImport` 는 성공하면 true — 대화상자를 닫고 안내를 띄우는 일은 부르는 쪽이 한다.
 */
export function ChromeImportDialog({ t, sources, persistent, owner = "operation", onClose, onImport }: {
  readonly t: T;
  readonly sources: ChromeImportSources;
  /** 쿠키가 들어갈 세션 — 영속 프로필이면 남고 임시 세션이면 탭과 함께 사라진다. */
  readonly persistent: boolean;
  /** 쿠키를 받는 브라우저 — 첫 줄과 임시 세션 설명이 그 브라우저의 이름으로 말한다. 영속 프로필 설명은 둘이 같다. */
  readonly owner?: "operation" | "global";
  readonly onClose: () => void;
  readonly onImport: (profileId: string) => Promise<boolean>;
}) {
  const [profile, setProfile] = React.useState(sources.profiles[0]?.id ?? "");
  const [importing, setImporting] = React.useState(false);
  const run = async () => {
    if (!profile) return;
    setImporting(true);
    try { await onImport(profile); } finally { setImporting(false); }
  };
  return (
    <div className="op-browser__scrim" onClick={() => { if (!importing) onClose(); }}>
      <div className="op-browser__dialog" role="dialog" aria-modal="true" aria-label={t("terminal.browser.import.title")} onClick={(event) => event.stopPropagation()}>
        <div className="op-browser__dialog-head">
          <div><h3>{t("terminal.browser.import.title")}</h3><p>{t(owner === "global" ? "terminal.globalBrowser.importBody" : "terminal.browser.import.body")}</p></div>
          <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.close")} disabled={importing} onClick={onClose}>×</button>
        </div>
        <label className="op-browser__dialog-row">
          <span className="op-browser__dialog-key">{t("terminal.browser.import.source")}</span>
          <span className="op-browser__dialog-brand" aria-hidden="true"><ChromeGlyph /></span>
          <span className="op-browser__select"><Select label="Google Chrome" value={profile} disabled={importing} onChange={(value) => setProfile(value)} options={sources.profiles.map((item) => ({ value: item.id, label: `${item.name}${item.account ? ` · ${item.account}` : ""}` }))} /></span>
        </label>
        <div className="op-browser__dialog-item">
          <span className="op-browser__dialog-glyph" aria-hidden="true"><GlobeGlyph /></span>
          <span><strong>{t("terminal.browser.import.cookies")}</strong><span className="op-browser__help">{t("terminal.browser.import.cookiesHelp")}</span></span>
        </div>
        <div className="op-browser__dialog-item is-target">
          <span className="op-browser__dialog-glyph" aria-hidden="true">{persistent ? <ProfileGlyph /> : <EphemeralGlyph />}</span>
          <span>
            <strong>{t(persistent ? "terminal.browser.import.intoProfile" : "terminal.browser.import.intoEphemeral")}</strong>
            <span className="op-browser__help">{t(persistent ? "terminal.browser.import.intoProfileHelp" : owner === "global" ? "terminal.globalBrowser.importIntoEphemeralHelp" : "terminal.browser.import.intoEphemeralHelp")}</span>
          </span>
        </div>
        <div className="op-browser__dialog-actions">
          <button type="button" className="op-browser__button" disabled={importing} onClick={onClose}>{t("terminal.browser.import.cancel")}</button>
          <button type="button" className="op-browser__button op-browser__button--primary" disabled={importing || !profile} onClick={() => void run()}>{importing ? t("terminal.browser.import.busy") : t("terminal.browser.import.run")}</button>
        </div>
      </div>
    </div>
  );
}
