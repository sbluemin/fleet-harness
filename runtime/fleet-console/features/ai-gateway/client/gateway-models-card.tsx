import * as React from "react";

import { navigateConsoleRoute } from "../../../core/client/src/integration/console-location.js";
import { getViewModeSnapshot } from "../../../core/client/src/integration/view-mode-store.js";
import { getT, useTerminalLocale } from "../../execution/client/agent/i18n/index.js";
import { requestQuotaPanelOpen } from "../../quota/client/toolbar-summary.js";
import { useMobileSettingsHost } from "../../settings/client/mobile-host.js";
import { SettingsGroup, SettingsSegments } from "../../settings/client/preferences-context.js";
import { closeSettingsModal } from "../../settings/client/settings-door.js";
import {
  loadSystemPromptSettings,
  setSystemPromptSettingsField,
  useSystemPromptSettingsStore,
  type AiGatewayCatalogProvider,
  type AiGatewayProviderId,
  type XaiEndpointPreference,
} from "../../settings/client/execution-settings.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore, type ModelAuthProviderState } from "./model-auth.js";
import { launchProviderFromModelId, launchProviderGlyph, type LaunchProviderGlyphId } from "./components/launch-provider-glyphs.js";

const PROVIDER_LABEL = {
  anthropic: "terminal.settings.aiGatewayProviderAnthropic",
  claude: "terminal.settings.aiGatewayProviderClaude",
  codex: "terminal.settings.aiGatewayProviderCodex",
  xai: "terminal.settings.aiGatewayProviderXai",
  "muse-code": "terminal.settings.aiGatewayProviderMuseCode",
  opencode: "terminal.settings.aiGatewayProviderOpencode",
  gemini: "terminal.settings.aiGatewayProviderGemini",
} as const;

/**
 * 게이트웨이가 각 공급자에 붙는 방식. OpenCode Go·Gemini·Anthropic은 Console에 저장한 API 키로,
 * 나머지는 구독 OAuth 자격으로 공급자 API를 직접 부른다.
 */
const PROVIDER_TRANSPORT = {
  anthropic: "terminal.settings.aiGatewayTransportApiKey",
  claude: "terminal.settings.aiGatewayTransportOauth",
  codex: "terminal.settings.aiGatewayTransportOauth",
  xai: "terminal.settings.aiGatewayTransportOauth",
  "muse-code": "terminal.settings.aiGatewayTransportOauth",
  opencode: "terminal.settings.aiGatewayTransportApiKey",
  gemini: "terminal.settings.aiGatewayTransportApiKey",
} as const;

/** 공급자 표시 순서: Claude가 맨 앞, 나머지 구독·CLI 공급자는 카탈로그 순서. */
const LAUNCH_ORDER: readonly LaunchProviderGlyphId[] = ["claude", "anthropic", "codex", "xai", "muse-code", "opencode", "gemini"];

/**
 * 공급자 표시 순서: Claude가 맨 앞, 나머지 구독·CLI 공급자는 카탈로그 순서.
 * 표시 순서는 소진 우선순위를 바꾸지 않는다.
 */
export function orderAiGatewayProviders<T extends { readonly id: string }>(providers: readonly T[]): T[] {
  const claude = providers.filter((provider) => provider.id === "claude");
  const rest = providers.filter((provider) => provider.id !== "claude");
  return [...claude, ...rest];
}

/**
 * 알약만의 표시. 위임 후보 수는 이 값이 아니라 로그인 상태로 센다.
 *
 * 동의만 꺼진 Claude는 자격이 로그아웃이 아니라서 후보로 남는다. 알약을 "확인 중"으로
 * 두면 조회가 곧 끝난다는 뜻이 되어, 동의를 켜기 전에는 영원히 그 문구가 남는다.
 */
export function gatewayLoginKind(provider: string | undefined, status: string | null | undefined): "in" | "out" | "unknown" | "unlinked" {
  if (provider === "claude" && status === "not_connected") return "unlinked";
  if (status == null) return "unknown";
  if (status === "signed_out" || status === "not_connected") return "out";
  return "in";
}

/** 박스 없는 순수 공급자 글리프 — 사령관·지휘관 칩의 ProviderMark와 같은 클래스다. */
function ProviderMark({ provider }: { readonly provider: LaunchProviderGlyphId }): React.ReactNode {
  return (
    <span className={`objective-launch-provider-glyph fc-coord-trigger-provider is-${provider}`} aria-hidden="true">
      {launchProviderGlyph(provider)}
    </span>
  );
}

/** 라우팅 풀에 담긴 모델들의 공급자를 런치 순서대로 중복 없이 뽑는다. */
function poolProviders(models: readonly { readonly id: string }[] | undefined): LaunchProviderGlyphId[] {
  if (!models) return [];
  const seen = new Set<LaunchProviderGlyphId>();
  for (const entry of models) {
    const provider = launchProviderFromModelId(entry.id);
    if (provider) seen.add(provider);
  }
  return LAUNCH_ORDER.filter((id) => seen.has(id));
}

const ROUTING_POOL_OPEN_EVENT = "fleet:open-routing-pool";

/**
 * 설정 표면을 닫고 사령관 대화의 라우팅 풀을 연다. 데스크톱은 모달을 닫으면
 * 그 아래 대화가 드러나고, 모바일은 대화 경로로 돌아간 뒤 풀을 연다.
 * 풀 팝오버 자체는 사령관 대화(임무 3)가 이 이벤트를 받아 연다.
 */
function openRoutingPoolInChat(): void {
  closeSettingsModal();
  window.dispatchEvent(new CustomEvent(ROUTING_POOL_OPEN_EVENT));
  if (getViewModeSnapshot().effective === "mobile") navigateConsoleRoute("/");
}

export function AiGatewayCompactCard(): React.ReactElement {
  const mobile = useMobileSettingsHost() !== null;
  const t = getT(useTerminalLocale(), mobile);
  const settings = useSystemPromptSettingsStore();
  const auth = useModelAuthStore();
  const state = settings.state;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  if (!state) {
    return (
      <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayProviders")}>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </SettingsGroup>
    );
  }

  const providers = orderAiGatewayProviders(state.aiGatewayCatalog.providers);
  // 카탈로그 공급자 중 API 키로 로그인하는 것. 그 공급자 줄이 키 입력을 진다.
  const keyAuthOf = (providerId: string): ModelAuthProviderState | undefined =>
    auth.state?.providers.find((entry) => entry.provider === providerId);
  const pool = poolProviders(state.aiGateway?.models);

  return (
    <div className="ai-gateway-models">
      <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayProviders")} title={t("terminal.settings.aiGatewayProviders")}>
        {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
        {auth.error ? <p className="global-settings-error" role="alert">{auth.error}</p> : null}
        {providers.map((provider) => (
          <ProviderLoginRow
            key={provider.id}
            provider={provider}
            status={state.aiGatewayLogin[provider.id] ?? null}
            keyAuth={keyAuthOf(provider.id)}
            busy={auth.busyProvider === provider.id}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup ariaLabel={t("terminal.settings.aiGatewayRoutingPool")}>
        <div className="ai-gateway-pool-row">
          <RoutingPoolStack providers={pool} />
          <div className="ai-gateway-pool-text">
            <p className="ai-gateway-pool-title">{t("terminal.settings.aiGatewayRoutingPool")}</p>
            <p className="ai-gateway-pool-help">{t("terminal.settings.aiGatewayRoutingPoolHelp")}</p>
          </div>
          <button type="button" className="ai-gateway-add-button" onClick={openRoutingPoolInChat}>
            {t("terminal.settings.aiGatewayRoutingPoolOpen")}
          </button>
        </div>
      </SettingsGroup>
    </div>
  );
}

function ProviderLoginRow({ provider, status, keyAuth, busy }: {
  readonly provider: AiGatewayCatalogProvider;
  readonly status: string | null;
  /** API 키로 로그인하는 공급자의 키 상태. 있으면 사용량 패널 대신 이 줄이 키를 받는다. */
  readonly keyAuth: ModelAuthProviderState | undefined;
  readonly busy: boolean;
}): React.ReactElement {
  const t = getT(useTerminalLocale(), useMobileSettingsHost() !== null);
  const name = t(PROVIDER_LABEL[provider.id]);
  const kind = gatewayLoginKind(provider.id, status);
  return (
    <div className="ai-gateway-login-row">
      <ProviderMark provider={provider.id} />
      <span className="ai-gateway-provider-heading">
        <span className="ai-gateway-provider-name">{name}</span>
        <span className="ai-gateway-transport">{t(PROVIDER_TRANSPORT[provider.id])}</span>
      </span>
      <span className="ai-gateway-login-control">
        {provider.id === "xai" ? <XaiEndpointSegments /> : null}
        {keyAuth ? (
          <ApiKeyLoginControl credential={keyAuth} name={name} busy={busy} />
        ) : kind === "unlinked" ? (
          <button type="button" className="ai-gateway-login is-unlinked" onClick={() => requestQuotaPanelOpen()}>{t("terminal.settings.aiGatewayUsageUnlinked")}</button>
        ) : kind === "out" ? (
          <>
            <span className="ai-gateway-login is-needed">{t("terminal.settings.aiGatewayNeedsLogin")}</span>
            <button type="button" className="ai-gateway-add-button" onClick={() => requestQuotaPanelOpen()}>{t("terminal.auth.signIn")}</button>
          </>
        ) : (
          <span className={`ai-gateway-login${kind === "unknown" ? " is-unknown" : ""}`}>
            {kind === "unknown" ? t("terminal.settings.aiGatewayLoginChecking") : t("terminal.settings.aiGatewaySignedIn")}
          </span>
        )}
      </span>
    </div>
  );
}

function RoutingPoolStack({ providers }: { readonly providers: readonly LaunchProviderGlyphId[] }): React.ReactElement {
  if (providers.length === 0) {
    return (
      <span className="ai-gateway-pool-stack" aria-hidden="true">
        <span className="ai-gateway-pool-empty">＋</span>
      </span>
    );
  }
  const shown = providers.length > 3 ? providers.slice(0, 2) : providers;
  const extra = providers.length - shown.length;
  return (
    <span className="ai-gateway-pool-stack" aria-hidden="true">
      {shown.map((provider) => (
        <span key={provider} className={`objective-launch-provider-glyph fc-coord-trigger-provider is-${provider}`}>
          {launchProviderGlyph(provider)}
        </span>
      ))}
      {extra > 0 ? <span className="ai-gateway-pool-more">+{extra}</span> : null}
    </span>
  );
}

/** xAI 행 안에 서는 엔드포인트 토글 — 별도 하위 행 없이 로그인 상태 앞에 놓인다. */
function XaiEndpointSegments(): React.ReactElement | null {
  const mobile = useMobileSettingsHost() !== null;
  const t = getT(useTerminalLocale(), mobile);
  const settings = useSystemPromptSettingsStore();
  const endpoint = settings.state?.xaiEndpoint;
  if (!endpoint) return null;
  const saving = settings.savingFields.has("xaiEndpoint");
  const options: readonly { readonly value: XaiEndpointPreference; readonly label: string }[] = [
    { value: "cli-proxy", label: t("terminal.settings.xaiEndpointProxy") },
    { value: "direct", label: t("terminal.settings.xaiEndpointDirect") },
  ];
  return (
    <span className="ai-gateway-endpoint">
      <SettingsSegments
        ariaLabel={t("terminal.settings.xaiEndpoint")}
        value={endpoint}
        disabled={saving}
        options={options}
        onChange={(next) => { void setSystemPromptSettingsField("xaiEndpoint", next); }}
      />
    </span>
  );
}

/** API 키 하나로 로그인하는 자격의 입력과 로그아웃. 키는 서버가 검증한 뒤에만 저장된다. */
function ApiKeyLoginControl({ credential, name, busy }: {
  readonly credential: ModelAuthProviderState;
  readonly name: string;
  readonly busy: boolean;
}): React.ReactElement {
  const mobile = useMobileSettingsHost() !== null;
  const t = getT(useTerminalLocale(), mobile);
  const [apiKey, setApiKey] = React.useState("");
  const afterChange = (ok: boolean): void => {
    if (!ok) return;
    setApiKey("");
    // 카탈로그 공급자의 로그인 상태는 설정 상태가 나른다. 키가 바뀌면 다시 읽는다.
    void loadSystemPromptSettings();
  };
  return credential.signedIn ? (
    <button type="button" className="ai-gateway-signout" disabled={busy} onClick={() => void signOutModel(credential.provider).then(afterChange)}>
      {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
    </button>
  ) : (
    <form className="ai-gateway-key-form" onSubmit={(event) => {
      event.preventDefault();
      void signInModel(credential.provider, apiKey).then(afterChange);
    }}>
      <input type="password" className="ai-gateway-key-input" placeholder={t("terminal.auth.apiKey")} value={apiKey} autoComplete="off" spellCheck={false} disabled={busy} aria-label={t("terminal.auth.apiKeyAria", { name })} onChange={(event) => setApiKey(event.target.value)} />
      <button type="submit" className="ai-gateway-add-button" disabled={busy || apiKey.trim().length === 0}>{busy ? t("terminal.auth.verifying") : t("terminal.auth.signIn")}</button>
    </form>
  );
}
