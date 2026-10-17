import { ExperimentalBadge, SettingsCard, SettingsRow, SettingsToggle, isComputerUseBackendId } from "@fleet-console/sdk/settings/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import type { ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

import { BACKENDS, ComputerUseRow, useComputerUseStatus } from "./computer-use-row.js";
import { setGlobalSettingsField } from "./global-settings-store.js";
import "./settings-mobile.css";
import { MobileIcon } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import type { GlobalSettingsState } from "../../../core/client/src/integration/types.js";

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
    <>
    <section className="global-settings-card" data-saving={saving || undefined} aria-label={t("settings.experiments.aiCard")}>
      <h3 className="global-settings-card-title">
        {t("settings.experiments.aiCard")}
        <ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge>
      </h3>
      <ComputerUseRow enabled={experiments.computerUse} backend={experiments.computerUseBackend} saving={saving} onChange={(computerUse) => save({ ...experiments, computerUse })} onBackendChange={(computerUseBackend) => save({ ...experiments, computerUseBackend, computerUse: false })} />
    </section>
    </>
  );
}

const saveExperiments = (next: ConsoleExperimentSettings) => void setGlobalSettingsField("experiments", next);

/**
 * The phone's experiments (S-48′). Built from the SDK settings parts, which the mobile settings host
 * draws in the mobile grammar: the card becomes a group with its badge, the switches description
 * toggle rows, and the backend a popup row. Help that the desktop
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
    <>
    <SettingsCard title={<>{t("settings.experiments.aiCard")}<ExperimentalBadge>{t("common.experimental")}</ExperimentalBadge></>}>
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
    </>
  );
}
