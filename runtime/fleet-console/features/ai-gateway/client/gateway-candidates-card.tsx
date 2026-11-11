import * as React from "react";

import { getT, useTerminalLocale } from "../../execution/client/agent/i18n/index.js";
import { useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import { SettingsGroup, SettingsHelpTip, SettingsItem } from "../../settings/client/preferences-context.js";
import { useSystemPromptSettingsStore } from "../../settings/client/execution-settings.js";
import { canonicalModelId, findRosterRow } from "../shared/models.js";
import { useModelRoster } from "./model-roster-store.js";

/**
 * 기계적 규칙의 순서 — `GET /api/v1/ai-gateway/candidates` 응답을 받는 그대로 그린다.
 * 배열 순서가 곧 여유 순서이고 `unknown`은 끝에 순위 없이 온다. 이 화면은 순위 번호·쿼터 수치·임계값처럼
 * 응답에 없는 값을 만들어 넣지 않는다.
 */
const CANDIDATES_PATH = "/api/v1/ai-gateway/candidates";
/** 쿼터는 계속 움직이므로 보이는 동안 주기적으로 다시 읽는다. */
const CANDIDATES_REFRESH_MS = 30_000;

type CandidatePressure = "ok" | "elevated" | "unknown";

interface GatewayCandidate {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly summary: string;
  readonly pressure: CandidatePressure;
}

type CandidatesLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly candidates: readonly GatewayCandidate[] }
  | { readonly kind: "error"; readonly reason: string };

function isCandidatePressure(value: unknown): value is CandidatePressure {
  return value === "ok" || value === "elevated" || value === "unknown";
}

/** 형식이 하나라도 어긋나면 null — 일부만 골라 보이면 응답과 다른 목록을 예측하게 된다. */
function parseCandidates(value: unknown): readonly GatewayCandidate[] | null {
  if (typeof value !== "object" || value === null) return null;
  const rows = (value as { readonly candidates?: unknown }).candidates;
  if (!Array.isArray(rows)) return null;
  const parsed: GatewayCandidate[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return null;
    const { model, efforts, summary, pressure } = row as Record<string, unknown>;
    if (
      typeof model !== "string" || model === ""
      || typeof summary !== "string"
      || !isCandidatePressure(pressure)
      || !Array.isArray(efforts) || !efforts.every((effort) => typeof effort === "string")
    ) return null;
    parsed.push({ model, efforts: efforts as string[], summary, pressure });
  }
  return parsed;
}

async function fetchCandidates(signal: AbortSignal): Promise<readonly GatewayCandidate[]> {
  const response = await fetch(CANDIDATES_PATH, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("invalid JSON");
  }
  const candidates = parseCandidates(body);
  if (!candidates) throw new Error("unexpected response shape");
  return candidates;
}

/**
 * `exposureKey`가 바뀌면(켠 모델·로그인 상태) 다시 읽는다. `paused`인 동안(설정 저장 중·상태 로드 전)은
 * 읽지 않는다 — 저장이 서버에 닿기 전에 읽으면 바뀌기 전 후보를 받는다.
 */
function useGatewayCandidates(exposureKey: string, paused: boolean): { readonly load: CandidatesLoad; readonly retry: () => void } {
  const [load, setLoad] = React.useState<CandidatesLoad>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (paused) return undefined;
    const controller = new AbortController();
    let latest = 0;
    const run = (): void => {
      const seq = ++latest;
      fetchCandidates(controller.signal).then(
        (candidates) => { if (seq === latest && !controller.signal.aborted) setLoad({ kind: "ready", candidates }); },
        (error: unknown) => {
          if (seq !== latest || controller.signal.aborted) return;
          setLoad({ kind: "error", reason: error instanceof Error ? error.message : String(error) });
        },
      );
    };
    run();
    const timer = window.setInterval(() => { if (!document.hidden) run(); }, CANDIDATES_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [exposureKey, paused, attempt]);
  const retry = React.useCallback(() => {
    setLoad({ kind: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return { load, retry };
}

const PRESSURE_LABEL_KEYS = {
  ok: "terminal.settings.candidatesPressureOk",
  elevated: "terminal.settings.candidatesPressureElevated",
  unknown: "terminal.settings.candidatesPressureUnknown",
} as const;

export function AiGatewayCandidatesCard(): React.ReactElement {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const settings = useSystemPromptSettingsStore();
  const roster = useModelRoster("agent");
  const state = settings.state;
  const exposureKey = state ? `${JSON.stringify(state.aiGateway?.models ?? [])}\n${JSON.stringify(state.aiGatewayLogin)}` : "";
  const { load, retry } = useGatewayCandidates(exposureKey, state === null || settings.savingFields.has("aiGateway"));
  const title = t("terminal.settings.candidates");

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={title}>
        <p className="global-settings-resp-title">{title}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  // 이름은 사람이 읽는 순서로: 로스터 행 → 카탈로그 이름 → 응답의 모델 ID 그대로.
  const catalogModels = state.aiGatewayCatalog.providers.flatMap((provider) => provider.models);
  const nameOf = (id: string): string =>
    findRosterRow(roster, id)?.label
    ?? catalogModels.find((model) => canonicalModelId(model.id) === canonicalModelId(id))?.name
    ?? id;

  // 켠 모델 중 응답에 없는 것 — 응답을 받은 뒤에만 안다. 조회 실패나 읽는 중에는 비교하지 않는다.
  const present = load.kind === "ready" ? new Set(load.candidates.map((candidate) => canonicalModelId(candidate.model))) : null;
  const leftOut = present === null ? [] : (state.aiGateway?.models ?? [])
    .filter((entry) => !present.has(canonicalModelId(entry.id)))
    .map((entry) => ({ id: entry.id, name: catalogModels.find((model) => model.id === entry.id)?.name ?? entry.id }));

  const help = (text: string, helpTitle: string) => (
    <SettingsHelpTip ariaLabel={t("terminal.settings.helpTipAria", { title: helpTitle })}>{text}</SettingsHelpTip>
  );

  return (
    <>
      <SettingsGroup ariaLabel={title} title={title} titleHelp={help(t("terminal.settings.candidatesHelp"), title)}>
        {load.kind === "loading" ? <p className="global-settings-help" role="status">{t("terminal.settings.candidatesLoading")}</p> : null}
        {load.kind === "error" ? (
          <div className="ai-gateway-candidate-notice">
            <p className="global-settings-error" role="alert">{t("terminal.settings.candidatesError")} ({load.reason})</p>
            <button type="button" className="ai-gateway-text-button" onClick={retry}>{t("terminal.settings.candidatesRetry")}</button>
          </div>
        ) : null}
        {load.kind === "ready" && load.candidates.length === 0 ? <p className="global-settings-help" role="status">{t("terminal.settings.candidatesEmpty")}</p> : null}
        {load.kind === "ready" ? load.candidates.map((candidate) => (
          <SettingsItem
            key={candidate.model}
            label={nameOf(candidate.model)}
            hint={candidate.summary || undefined}
          >
            <span className="ai-gateway-candidate-state">
              <span className={`ai-gateway-candidate-pressure is-${candidate.pressure}`}>{t(PRESSURE_LABEL_KEYS[candidate.pressure])}</span>
              <span className="ai-gateway-candidate-efforts">
                {candidate.efforts.length > 0
                  ? t("terminal.settings.candidatesEfforts", { levels: candidate.efforts.join(" · ") })
                  : t("terminal.settings.candidatesNoEffort")}
              </span>
            </span>
          </SettingsItem>
        )) : null}
      </SettingsGroup>
      {leftOut.length > 0 ? (
        <SettingsGroup
          ariaLabel={t("terminal.settings.candidatesOut")}
          title={t("terminal.settings.candidatesOut")}
          titleHelp={help(t("terminal.settings.candidatesOutHelp"), t("terminal.settings.candidatesOut"))}
        >
          {leftOut.map((entry) => (
            <SettingsItem key={entry.id} label={entry.name}>
              <span className="ai-gateway-candidate-state">
                <span className="ai-gateway-candidate-pressure is-out">{t("terminal.settings.candidatesOutBadge")}</span>
              </span>
            </SettingsItem>
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}
