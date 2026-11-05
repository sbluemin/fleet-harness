import { useEffect, useRef, useState } from "react";
import { SettingsRow, SettingsToggle } from "./preferences-context.js";

import { useT } from "../../../core/client/src/i18n/index.js";
import { fetchCommodoreBasePrompt, fetchCommodoreSubagents, saveCommodoreBasePrompt, saveCommodoreSubagents } from "./commodore-settings.js";
import "./commodore-session-settings.css";

type CommodoreToggleState = "loading" | "ready" | "saving" | "loadFailed" | "saveFailed";

export interface CommodoreToggleController {
  readonly value: boolean | null;
  readonly state: CommodoreToggleState;
  readonly change: (next: boolean) => void;
}

/** 사령관 한 명의 켬·끔 설정 하나를 읽고 저장한다. 실패한 저장은 앞 값으로 되돌린다. */
function useCommodoreToggle(commodoreId: string, read: (id: string, signal: AbortSignal) => Promise<boolean>, write: (id: string, next: boolean) => Promise<boolean>): CommodoreToggleController {
  const [value, setValue] = useState<boolean | null>(null);
  const [state, setState] = useState<CommodoreToggleState>("loading");
  const revisionRef = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    ++revisionRef.current;
    setValue(null);
    setState("loading");
    void read(commodoreId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setValue(result);
      setState("ready");
    }, () => { if (!controller.signal.aborted) setState("loadFailed"); });
    return () => controller.abort();
  }, [commodoreId]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next: boolean) => {
    const previous = value;
    const revision = ++revisionRef.current;
    setValue(next);
    setState("saving");
    void write(commodoreId, next).then((result) => {
      if (revision !== revisionRef.current) return;
      setValue(result);
      setState("ready");
    }, () => {
      if (revision !== revisionRef.current) return;
      setValue(previous);
      setState("saveFailed");
    });
  };
  return { value, state, change };
}

/** 이 사령관의 새 Claude Code 세션에 Claude Code 기본 시스템 지침을 실을지. 기본은 켬이다. */
export function useCommodoreBasePrompt(commodoreId: string): CommodoreToggleController {
  return useCommodoreToggle(
    commodoreId,
    async (id, signal) => (await fetchCommodoreBasePrompt(id, signal)).basePromptEnabled,
    async (id, next) => (await saveCommodoreBasePrompt(id, next)).basePromptEnabled,
  );
}

/** 접힌 요약과 스위치가 같은 허용값·저장 상태를 공유한다. */
export function useCommanderSubagents(commodoreId: string): CommodoreToggleController {
  return useCommodoreToggle(
    commodoreId,
    async (id, signal) => (await fetchCommodoreSubagents(id, signal)).subagentsKept,
    async (id, next) => (await saveCommodoreSubagents(id, next)).subagentsKept,
  );
}

function CommodoreToggleRow({ controller, mobile, label, ariaLabel, onHint, offHint, loadFailed, saveFailed }: {
  readonly controller: CommodoreToggleController;
  readonly mobile: boolean;
  readonly label: string;
  readonly ariaLabel: string;
  readonly onHint: string;
  readonly offHint: string;
  readonly loadFailed: string;
  readonly saveFailed: string;
}) {
  const t = useT(mobile);
  const { value, state, change } = controller;
  return (
    <div className="commodore-session-setting">
      <SettingsRow label={label} hint={value === null ? undefined : value ? onHint : offHint}>
        {state === "loading" ? <span className="commodore-session-setting-status" role="status">{t("sidebar.commodore.setting.loading")}</span>
          : state === "loadFailed" ? <span className="commodore-session-setting-status is-error" role="alert">{loadFailed}</span>
            : <SettingsToggle checked={value === true} busy={state === "saving"} ariaLabel={ariaLabel} onChange={change} />}
      </SettingsRow>
      {state === "saveFailed" ? <p className="commodore-session-setting-status is-error" role="alert">{saveFailed}</p> : null}
    </div>
  );
}

/** Claude Code 기본 시스템 지침 탑재 여부. 사령관의 지휘관·구성원 모두의 새 세션에 적용된다. */
export function CommodoreBasePromptSection({ controller, mobile = false }: { readonly controller: CommodoreToggleController; readonly mobile?: boolean }) {
  const t = useT(mobile);
  return (
    <CommodoreToggleRow
      controller={controller}
      mobile={mobile}
      label={t("sidebar.commodore.basePrompt.toggle")}
      ariaLabel={t("sidebar.commodore.basePrompt.ariaLabel")}
      onHint={t("sidebar.commodore.basePrompt.onHint")}
      offHint={t("sidebar.commodore.basePrompt.offHint")}
      loadFailed={t("sidebar.commodore.basePrompt.loadFailed")}
      saveFailed={t("sidebar.commodore.setting.saveFailed")}
    />
  );
}

/** 지휘관 허용만 바꾼다. 구성원 정책과 분리된 설정임을 같은 줄의 설명으로 알린다. */
export function CommanderSubagentsSection({ controller, mobile = false }: { readonly controller: CommodoreToggleController; readonly mobile?: boolean }) {
  const t = useT(mobile);
  return (
    <CommodoreToggleRow
      controller={controller}
      mobile={mobile}
      label={t("sidebar.commodore.commanderSubagents.toggle")}
      ariaLabel={t("sidebar.commodore.commanderSubagents.ariaLabel")}
      onHint={t("sidebar.commodore.commanderSubagents.allowedHint")}
      offHint={t("sidebar.commodore.commanderSubagents.blockedHint")}
      loadFailed={t("sidebar.commodore.commanderSubagents.loadFailed")}
      saveFailed={t("sidebar.commodore.setting.saveFailed")}
    />
  );
}
