import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { SettingsSegments } from "@fleet-console/sdk/settings/browser";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ArchiveRetentionDays } from "../../../../core/client/src/integration/types.js";
import { loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../../../settings/client/global-settings-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHOICES = ["off", "7", "30", "90"] as const;
type Choice = typeof CHOICES[number];

const choiceOf = (days: ArchiveRetentionDays): Choice => days === null ? "off" : String(days) as Choice;
const daysOf = (choice: Choice): ArchiveRetentionDays => choice === "off" ? null : Number(choice) as 7 | 30 | 90;

/**
 * 보관함의 자동 정리 정책. 고르기는 이 화면의 초안일 뿐이고, 서버 정책은 「적용」이 서버 응답을
 * 받은 뒤에만 바뀐 것으로 말한다 — 스토어는 저장 중 값을 낙관적으로 얹으므로 저장 중에는 값 대신
 * 「저장 중」을 보인다. 실제 삭제는 서버의 주기 확인이 맡고, 여기서는 아무것도 지우지 않는다.
 */
export function ArchiveRetention({ open, onOpenChange, archivedAts }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 자동 정리 대상(모든 Theater의 보관 루트 중 삭제 보류가 아닌 것)의 보관 시각. */
  readonly archivedAts: readonly number[];
}) {
  const t = useT();
  const settings = useGlobalSettingsStore();
  const saving = settings.savingFields.has("archiveRetentionDays");
  const saved = settings.state?.archiveRetentionDays ?? null;
  const [draft, setDraft] = useState<Choice>(choiceOf(saved));
  const [result, setResult] = useState<"saved" | "failed" | null>(null);
  // 확인하지 못한 저장 뒤의 불확실 — 실패한 PUT은 서버에 기록됐을 수 있다. 이 필드의 PUT이 다음에
  // 성공할 때만 거둔다. 시트를 닫았다 열어 이 플래그가 사라져도, 재조회가 실패하거나 건너뛰어진 동안은
  // 스토어의 저장 실패(error)가 남아 같은 보수 표시를 잇는다(무관한 필드의 실패라도). 재조회가 성공해
  // error가 거둬졌다면 서버 값이 hydrate된 것이므로 정상 요약으로 돌아가도 된다.
  const [uncertainSave, setUncertainSave] = useState(false);
  const uncertain = uncertainSave || settings.error !== null;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const titleId = useId();
  const panelId = useId();

  const savedRef = useRef(saved);
  savedRef.current = saved;
  // 열 때의 서버 값으로만 초안을 시작한다 — 열린 동안 다른 창의 저장이 초안을 덮지 않는다.
  useEffect(() => { if (open) setDraft(choiceOf(savedRef.current)); }, [open]);
  // 패널이 닫히며(적용·취소·Esc) 그 안의 초점이 사라지면 「변경」 단추로 돌려보낸다.
  // 시트의 레이아웃 효과가 BODY 초점을 줄로 옮기기 전에 자식인 여기서 먼저 잡는다.
  useLayoutEffect(() => {
    if (open) { restoreFocus.current = true; return; }
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body || !document.activeElement?.isConnected) toggleRef.current?.focus();
  }, [open]);

  const close = () => onOpenChange(false);
  const draftDays = daysOf(draft);
  // 불확실하면 같은 값(특히 꺼짐)도 다시 명시적으로 적용할 수 있어야 한다.
  const unchanged = !uncertain && draftDays === saved;
  const now = Date.now();
  const expired = draftDays === null ? 0 : archivedAts.filter((at) => Number.isFinite(at) && at <= now && now - at >= draftDays * DAY_MS).length;
  const unavailable = settings.state === null;
  const apply = async () => {
    if (saving || unchanged || unavailable) return;
    setResult(null);
    const ok = await setGlobalSettingsField("archiveRetentionDays", draftDays);
    // 실패는 「저장 안 됨」이 아니다 — 서버가 기록한 뒤 응답만 잃었을 수 있다. 스토어의 되돌림을 믿지 않고
    // 서버 값을 다시 읽어 요약이 실제 정책을 말하게 한다. 재조회까지 실패하면 실패 안내만 남는다.
    if (!ok) { setUncertainSave(true); await loadGlobalSettings(); }
    else setUncertainSave(false);
    setResult(ok ? "saved" : "failed");
    if (ok) close();
  };
  const summary = saving ? t("archive.retention.saving")
    : uncertain ? t("archive.retention.summaryUncertain")
    : saved === null ? t("archive.retention.summaryOff") : t("archive.retention.summaryOn", { days: saved });

  return <section className={`archive-retention${open ? " is-open" : ""}`} aria-labelledby={titleId}>
    <div className="archive-retention-row">
      <span id={titleId} className="archive-retention-label">{t("archive.retention.label")}</span>
      <span className="archive-retention-summary" aria-live="polite">{unavailable ? t("archive.retention.unavailable") : summary}</span>
      {open || unavailable ? null : <button ref={toggleRef} type="button" className="archive-retention-toggle" aria-expanded={false} aria-controls={panelId}
        aria-disabled={saving || undefined} onClick={() => { if (!saving) { setResult(null); onOpenChange(true); } }}>{t("archive.retention.change")}</button>}
    </div>
    {result ? <p className={`archive-retention-result${result === "failed" ? " is-failed" : ""}`} role={result === "failed" ? "alert" : "status"}>
      {t(result === "failed" ? "archive.retention.failed" : "archive.retention.saved")}
    </p> : null}
    {open && !unavailable ? <div id={panelId} className="archive-retention-panel">
      <ul className="archive-retention-help">
        <li className="is-warning">{t("archive.retention.helpPermanent")}</li>
        <li>{t("archive.retention.helpScope")}</li>
        <li>{t("archive.retention.helpAge")}</li>
        <li>{t("archive.retention.helpOff")}</li>
      </ul>
      <SettingsSegments value={draft} ariaLabel={t("archive.retention.choiceAria")} disabled={saving}
        options={CHOICES.map((choice) => ({ value: choice, label: choice === "off" ? t("archive.retention.off") : t("archive.retention.days", { days: choice }) }))}
        onChange={(next) => { setDraft(next); setResult(null); }} />
      {expired > 0 && !unchanged ? <p className="archive-retention-expired" role="status">{t("archive.retention.expiredNow", { count: expired })}</p> : null}
      <div className="archive-retention-actions">
        <button type="button" className={`archive-retention-apply${draftDays === null ? "" : " is-destructive"}`} aria-disabled={saving || unchanged || undefined}
          onClick={() => { void apply(); }}>{saving ? t("archive.retention.saving") : t(draftDays === null ? "archive.retention.applyOff" : "archive.retention.apply")}</button>
        <button type="button" className="archive-retention-cancel" aria-disabled={saving || undefined} onClick={() => { if (!saving) { setResult(null); close(); } }}>{t("archive.retention.cancel")}</button>
      </div>
    </div> : null}
  </section>;
}
