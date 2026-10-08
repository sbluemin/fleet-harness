import { DEFAULT_EXPERIMENT_AIDE_SELECTION, ExperimentalBadge, SettingsCard, SettingsRow, SettingsToggle, isComputerUseBackendId, isExperimentEffort } from "@fleet-console/sdk/settings/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import { ModelCoordinatePicker } from "@fleet-console/sdk/components/model-coordinate-picker";
import type { ConsoleExperimentSettings, ExperimentAideId } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { BACKENDS, ComputerUseRow, useComputerUseStatus } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
import "./settings-mobile.css";
import { MobileIcon, type MobileIconName } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import type { CoreMessageKey } from "../../../core/client/src/i18n/messages/index.js";
import { useModelRoster } from "../../ai-gateway/client/model-roster-store.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";

/**
 * 보조 AI 한 좌석의 모델·강도 — Console 공유 선택기 하나로 고른다. 선택지는 모델 로스터(Agent SDK 대상)이고 강도는
 * 고른 모델이 내놓는 사다리 전체다. 로스터 밖 저장값은 「꺼짐」으로 남아 보이고, 다시 저장하기 전까지 고쳐 쓰지 않는다.
 * 저장은 정준 id로 한다 — 옛 표기(`claude-gateway--…`)는 다음 저장 때 접힌다.
 */
function AideCoordinate({ aide, experiments, saving, title, onSave }: {
  readonly aide: ExperimentAideId;
  readonly experiments: ConsoleExperimentSettings;
  readonly saving: boolean;
  readonly title: string;
  readonly onSave: (next: ConsoleExperimentSettings) => void;
}) {
  const t = useT();
  const roster = useModelRoster("agent");
  const modelField = `${aide}Model` as const;
  const effortField = `${aide}Effort` as const;
  return (
    <ModelCoordinatePicker
      roster={roster}
      value={{ model: experiments[modelField], effort: experiments[effortField] }}
      fallback={DEFAULT_EXPERIMENT_AIDE_SELECTION}
      disabled={saving}
      onChange={(next) => onSave({
        ...experiments,
        ...(next.model ? { [modelField]: next.model } : {}),
        // 강도를 받지 않는 모델을 고르면 강도는 그대로 둔다 — 다시 강도 있는 모델로 돌아오면 그 값이 산다.
        ...(isExperimentEffort(next.effort) ? { [effortField]: next.effort } : {}),
      })}
      labels={{
        menu: t("settings.experiments.modelAria", { feature: title }),
        effort: t("settings.experiments.effortAria", { feature: title }),
        auto: t("settings.models.auto"),
        back: t("settings.models.back"),
        loading: t("settings.models.loading"),
        empty: t("settings.models.empty"),
        off: t("settings.models.off"),
        fallback: t("settings.models.fallback"),
      }}
      trigger={{ variant: "field" }}
    />
  );
}

interface AideRow {
  readonly id: ExperimentAideId;
  readonly titleKey: CoreMessageKey;
  readonly helpKey: CoreMessageKey;
}

/** 항상 켜져 있는 보조 AI — 스위치 없이 모델과 강도만 고른다. 두 컴포저에는 이 좌표를 고르는 자리가 없다. */
const AIDE_ROWS: readonly AideRow[] = [
  { id: "cowork", titleKey: "settings.experiments.cowork.title", helpKey: "settings.experiments.cowork.help" },
  { id: "analyst", titleKey: "settings.experiments.analyst.title", helpKey: "settings.experiments.analyst.help" },
];

export function ExperimentsSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  // The phone reads the same experiments through group rows and sheets (S-48): no boxed effort
  // selector, no help chips, no desktop toggle.
  if (useViewMode().effective === "mobile") return <MobileExperiments state={state} saving={saving} />;
  return <DesktopExperiments state={state} saving={saving} />;
}

function DesktopExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const save = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

  return (
    <section className="global-settings-card" data-saving={saving || undefined} aria-label={t("settings.experiments.aiCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.aiCard")}
        <ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge>
      </h3>
      {AIDE_ROWS.map((row) => (
        <div className="global-settings-row experiments-row" key={row.id}>
          <div className="global-settings-row-text">
            <p className="global-settings-resp-title">
              {t(row.titleKey)}
              <SettingsHelp title={t(row.titleKey)}>{t(row.helpKey)}</SettingsHelp>
            </p>
          </div>
          <div className="experiments-row-controls">
            <AideCoordinate aide={row.id} experiments={experiments} saving={saving} title={t(row.titleKey)} onSave={save} />
          </div>
        </div>
      ))}
      {/* 자율 운영 — 켬/끔. 기본 좌표는 Opus/High이고, Theater 마다 사령관 시트에서 바꿀 수 있다. */}
      <div className="global-settings-row experiments-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("settings.experiments.commodore.title")}
            <SettingsHelp title={t("settings.experiments.commodore.title")}>{t("settings.experiments.commodore.help")}</SettingsHelp>
          </p>
        </div>
        <div className="experiments-row-controls">
          <SettingsToggle
            checked={experiments.commodore}
            busy={saving}
            ariaLabel={t("settings.experiments.commodore.title")}
            onChange={(next) => save({ ...experiments, commodore: next })}
          />
        </div>
      </div>
      <ComputerUseRow enabled={experiments.computerUse} backend={experiments.computerUseBackend} saving={saving} onChange={(computerUse) => save({ ...experiments, computerUse })} onBackendChange={(computerUseBackend) => save({ ...experiments, computerUseBackend, computerUse: false })} />
    </section>
  );
}

const saveExperiments = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

/** [pennant] 사령관 깃발(impl-spec §A) — 폰의 「자율 운영」 행과 드로어 「사령관」 줄이 같은 아이콘을 쓴다. */
const PennantGlyph = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 21V3.5" />
    <path d="M5.5 4.5h13l-3.6 4.25 3.6 4.25h-13" />
  </svg>
);

const AIDE_ICONS: Partial<Record<ExperimentAideId, MobileIconName>> = { cowork: "wiki", analyst: "chart" };

/**
 * The phone's experiments (S-48′). Built from the SDK settings parts, which the mobile settings host
 * draws in the mobile grammar: the card becomes a group with its badge, each aide a model popup
 * row, the switches description toggle rows, and the backend a popup row. Help that the desktop
 * keeps behind 「?」 is the row's description here.
 */
function MobileExperiments({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const experiments = state.experiments;
  const computerUse = useComputerUseStatus(experiments.computerUse, experiments.computerUseBackend);
  const backend = experiments.computerUseBackend;
  const computerUseReady = computerUse.status?.backend === backend && computerUse.status.supported && !computerUse.unavailable && computerUse.status.installation === "available";
  const computerUseLocked = !experiments.computerUse && !computerUseReady;
  // Why the switch cannot turn on yet, as one sentence at the end of the description (P-2).
  const lockReason = !computerUseLocked ? null
    : computerUse.unavailable ? t("settings.computerUse.connectionFailed")
      : computerUse.status === null || computerUse.status.backend !== backend ? t("settings.computerUse.checking")
        : !computerUse.status.supported ? t("settings.computerUse.unavailable")
          : computerUse.status.installation === "missing" ? t(backend === "cua-driver" ? "settings.computerUse.missing" : "settings.computerUse.skyMissing")
            : null;
  const computerUseHint = (
    <>
      {t("settings.computerUse.help")}
      {lockReason ? <> {lockReason}</> : null}
      {computerUse.code ? <span role="alert"> {t(`settings.computerUse.${computerUse.errorKey}`)}</span> : null}
      {backend === "cua-driver" && computerUse.status?.installation === "missing" && computerUse.status.installer?.supported
        ? <> <button type="button" className="settings-mobile-textlink" disabled={computerUse.installing} onClick={(event) => { event.stopPropagation(); void computerUse.install(); }}>{t(computerUse.installing ? "settings.computerUse.installing" : "settings.computerUse.install")}</button></> : null}
      {computerUse.unavailable ? <> <button type="button" className="settings-mobile-textlink" onClick={(event) => { event.stopPropagation(); computerUse.retry(); }}>{t("settings.computerUse.retry")}</button></> : null}
      {computerUse.active ? <> <button type="button" className="settings-mobile-textlink" disabled={computerUse.working || computerUse.status?.state === "stopping"} onClick={(event) => { event.stopPropagation(); void computerUse.stop(); }}>{t("settings.computerUse.stop")}</button></> : null}
    </>
  );
  return (
    <SettingsCard title={<>{t("settings.experiments.aiCard")}<ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge></>}>
      {AIDE_ROWS.map((row) => (
        <SettingsRow key={row.id} label={t(row.titleKey)} hint={t(row.helpKey)} icon={<MobileIcon name={AIDE_ICONS[row.id] ?? "spark"} />}>
          <AideCoordinate aide={row.id} experiments={experiments} saving={saving} title={t(row.titleKey)} onSave={saveExperiments} />
        </SettingsRow>
      ))}
      <SettingsRow label={t("settings.experiments.commodore.title")} hint={t("settings.experiments.commodore.mobileHelp")} icon={<PennantGlyph />}>
        <SettingsToggle
          checked={experiments.commodore}
          busy={saving}
          ariaLabel={t("settings.experiments.commodore.title")}
          onChange={(next) => saveExperiments({ ...experiments, commodore: next })}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.computerUse.title")} hint={computerUseHint} icon={<MobileIcon name="layout" />} disabled={computerUseLocked}>
        <SettingsToggle
          checked={experiments.computerUse}
          busy={saving || computerUse.working}
          disabled={computerUseLocked}
          ariaLabel={t("settings.computerUse.title")}
          onChange={(next) => saveExperiments({ ...experiments, computerUse: next })}
        />
      </SettingsRow>
      {/* The backend stays selectable while Computer Use is off: the switch only turns on once the
          chosen backend's runtime is available, so locking the choice would leave no way to get there. */}
      <SettingsRow label={t("settings.computerUse.backend")} icon={<MobileIcon name="swap" />}>
        <Select
          value={backend}
          options={BACKENDS}
          disabled={saving || computerUse.working}
          label={t("settings.computerUse.backend")}
          onChange={(next) => { if (isComputerUseBackendId(next) && next !== backend) saveExperiments({ ...experiments, computerUseBackend: next, computerUse: false }); }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
