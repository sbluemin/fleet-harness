import {
  cancel,
  groupMultiselect,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  select,
} from "@clack/prompts";
import {
  DEFAULT_XAI_ENDPOINT_PREFERENCE,
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_NAMES,
  type AiGatewaySettingsStore,
  type AiGatewayStoredSettings,
  type GatewayProvider,
} from "@dotobokuri/core-ai-gateway";

import {
  buildCompactCeilingChoices,
  describeGatewayPolicy,
  nextPriorityDefault,
  resolveCompactCeilingChoice,
  writeProviderPriority,
  type CompactCeilingChoice,
} from "./policy.js";
import { collectGatewayModels } from "./report.js";
import {
  buildGatewayModelChoices,
  effortLadderFor,
  toStoredModels,
  withModelEfforts,
  withModelHostOnly,
} from "./selection.js";
import type { AuthCommandDeps, AuthCommandIo } from "../auth/login-flow.js";

export interface GatewayInteractiveIo {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
}

export interface GatewayInteractiveDeps {
  readonly store: AiGatewaySettingsStore;
  readonly authService: AuthCommandDeps["authService"];
  readonly dispatchAuthCommand: (
    argv: readonly string[],
    io: AuthCommandIo,
    deps: AuthCommandDeps,
  ) => Promise<number>;
}

type MenuChoice = "models" | "providers" | "priority" | "policy" | "diagnostics" | "exit";

export async function runGatewayInteractive(
  io: GatewayInteractiveIo,
  deps: GatewayInteractiveDeps,
): Promise<number> {
  if (io.stdout.isTTY !== true) {
    io.stderr.write(
      "fleet gateway needs an interactive terminal.\nUse `fleet gateway status`, `fleet gateway models`, or `fleet gateway set` instead.\n",
    );
    return 1;
  }

  intro("Fleet AI Gateway");
  log.message(deps.store.path);

  for (;;) {
    const settings = deps.store.read();
    const choice = await select<MenuChoice>({
      message: "What do you want to change?",
      options: [
        { value: "models", label: "Models", hint: summarizeModels(settings) },
        { value: "providers", label: "Providers", hint: await summarizeProviders(deps) },
        { value: "priority", label: "Spend priority", hint: describeGatewayPolicy(settings)["provider-priority"] },
        { value: "policy", label: "Policy", hint: summarizePolicy(settings) },
        { value: "diagnostics", label: "Diagnostics", hint: summarizeDiagnostics(settings) },
        { value: "exit", label: "Exit" },
      ],
    });
    if (isCancel(choice) || choice === "exit") break;

    if (choice === "models") await editModels(deps);
    else if (choice === "providers") await editProviders(io, deps);
    else if (choice === "priority") await editPriority(deps);
    else if (choice === "policy") await editPolicy(deps);
    else await editDiagnostics(deps);
  }

  outro("Saved. An open Console shows the change after a reload.");
  return 0;
}

async function editModels(deps: GatewayInteractiveDeps): Promise<void> {
  const settings = deps.store.read();
  const choices = buildGatewayModelChoices(settings);
  const groups = Object.fromEntries(
    Object.entries(choices.groups).map(([provider, models]) => [
      provider,
      models.map((model) => ({ value: model.id, label: model.label, hint: model.hint })),
    ]),
  );
  const selected = await groupMultiselect<string>({
    message: "Which models does the gateway expose?",
    options: groups,
    initialValues: [...choices.selectedIds],
    required: false,
    selectableGroups: false,
  });
  if (isCancel(selected)) return;

  const models = toStoredModels(selected, settings.models);
  deps.store.write({ models });
  log.success(models.length === 0 ? "No models exposed." : `${models.length} models exposed.`);
  if (models.length > 0) await adjustModelDetail(deps);
}

/** 강도 사다리와 host-only는 모델마다 붙는 축이라 노출 선택과 분리된 두 번째 걸음이다. */
async function adjustModelDetail(deps: GatewayInteractiveDeps): Promise<void> {
  for (;;) {
    const models = collectGatewayModels(deps.store.read());
    if (models.length === 0) return;
    const target = await select<string>({
      message: "Adjust effort or host-only?",
      options: [
        ...models.map((model) => ({
          value: model.id,
          label: model.name,
          hint: [
            model.efforts.length > 0 ? `effort ${model.efforts.join("·")}` : "no effort ladder",
            model.hostOnly ? "host-only" : undefined,
          ].filter((axis): axis is string => axis !== undefined).join(" · "),
        })),
        { value: "", label: "Done", hint: "back to the menu" },
      ],
      // 기본은 Done이다. 이 화면은 모델 편집기가 자동으로 넘겨주므로, 기본값이 없으면 커서가
      // 첫 모델에 놓이고 — 사다리 없는 모델이면 다음 화면의 선택지가 Host-only 하나뿐이라 —
      // 그냥 지나가려던 엔터 두 번이 위임 로스터를 바꿔 버린다.
      initialValue: "",
    });
    if (isCancel(target) || target === "") return;

    const ladder = effortLadderFor(target);
    const axis = await select<"efforts" | "host-only">({
      message: models.find((model) => model.id === target)?.name ?? target,
      options: [
        ...(ladder.length > 0
          ? [{ value: "efforts" as const, label: "Effort levels", hint: ladder.join("·") }]
          : []),
        {
          value: "host-only" as const,
          label: "Host-only",
          hint: "stays on the wire, but is not offered as a delegation identity",
        },
      ],
    });
    if (isCancel(axis)) continue;

    const stored = deps.store.read().models ?? [];
    if (axis === "efforts") {
      const current = stored.find((entry) => entry.id === target)?.efforts;
      const efforts = await multiselect<string>({
        message: "Which effort levels are exposed?",
        options: ladder.map((level) => ({ value: level, label: level })),
        initialValues: [...(current ?? ladder)],
        required: false,
      });
      if (isCancel(efforts)) continue;
      // 사다리 전체를 고른 것은 "좁히지 않음"과 같다 — 키를 남기지 않아야 카탈로그가
      // 사다리를 넓힐 때 사용자의 선택이 옛 목록에 갇히지 않는다.
      const narrowed = efforts.length === ladder.length ? [] : efforts;
      deps.store.write({ models: withModelEfforts(stored, target, narrowed) });
      log.success(narrowed.length === 0 ? "Effort: the whole ladder." : `Effort: ${narrowed.join("·")}.`);
      continue;
    }

    const hostOnly = stored.find((entry) => entry.id === target)?.hostOnly === true;
    deps.store.write({ models: withModelHostOnly(stored, target, !hostOnly) });
    log.success(hostOnly ? "Host-only off — delegable again." : "Host-only on.");
  }
}

async function editProviders(io: GatewayInteractiveIo, deps: GatewayInteractiveDeps): Promise<void> {
  const action = await select<"login" | "logout" | "back">({
    message: "Provider authentication",
    options: [
      { value: "login", label: "Sign in", hint: "Kimi or OpenCode Go API key" },
      { value: "logout", label: "Sign out" },
      { value: "back", label: "Back" },
    ],
  });
  if (isCancel(action) || action === "back") return;
  await deps.dispatchAuthCommand(["auth", action], io, { authService: deps.authService });
}

async function editPriority(deps: GatewayInteractiveDeps): Promise<void> {
  const settings = deps.store.read();
  const ordered: GatewayProvider[] = [];
  for (;;) {
    const remaining = GATEWAY_PROVIDERS.filter((provider) => !ordered.includes(provider));
    if (remaining.length === 0) break;
    const next = await select<GatewayProvider | "">({
      message: ordered.length === 0
        ? "Which provider's allowance is spent first?"
        : `Next after ${ordered.map((provider) => GATEWAY_PROVIDER_NAMES[provider]).join(" → ")}`,
      options: [
        ...remaining.map((provider) => ({ value: provider, label: GATEWAY_PROVIDER_NAMES[provider] })),
        {
          value: "" as const,
          label: ordered.length === 0 ? "No preference" : "Done",
          hint: ordered.length === 0 ? "clears the stored order" : "leave the rest unranked",
        },
      ],
      initialValue: nextPriorityDefault(settings.providerPriority, ordered, remaining),
    });
    if (isCancel(next)) return;
    if (next === "") break;
    ordered.push(next);
  }
  writeProviderPriority(deps.store, ordered);
  log.success(ordered.length === 0
    ? "Spend priority cleared."
    : `Spend priority: ${ordered.join(" → ")}.`);
}

async function editPolicy(deps: GatewayInteractiveDeps): Promise<void> {
  const settings = deps.store.read();
  const ceilingChoices = buildCompactCeilingChoices(settings.compactCeiling);
  const ceiling = await select<CompactCeilingChoice>({
    message: "When does a turn compact?",
    options: [...ceilingChoices.options],
    initialValue: ceilingChoices.initialValue,
  });
  if (isCancel(ceiling)) return;
  deps.store.writeCompactCeiling(resolveCompactCeilingChoice(ceiling, settings.compactCeiling));

  const endpoint = await select<"direct" | "cli-proxy">({
    message: "Which xAI endpoint does a subscription turn open on?",
    options: [
      { value: "cli-proxy", label: "CLI proxy", hint: "the Grok CLI's own pool (default)" },
      { value: "direct", label: "Direct", hint: "shared standard-tier pool; can park or refuse at capacity" },
    ],
    initialValue: settings.xaiEndpoint ?? DEFAULT_XAI_ENDPOINT_PREFERENCE,
  });
  if (isCancel(endpoint)) return;
  deps.store.writeXaiEndpoint(endpoint);
  log.success(`Compact ${describeGatewayPolicy(deps.store.read())["compact-ceiling"]} · xAI ${endpoint}.`);
}

async function editDiagnostics(deps: GatewayInteractiveDeps): Promise<void> {
  const settings = deps.store.read();
  const wireLog = await select<"auto" | "on" | "off">({
    message: "Log gateway wire traffic?",
    options: [
      { value: "auto", label: "Auto", hint: "follow FLEET_GATEWAY_WIRE_LOG" },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    initialValue: settings.wireLogEnabled === undefined ? "auto" : settings.wireLogEnabled ? "on" : "off",
  });
  if (isCancel(wireLog)) return;
  deps.store.writeWireLogEnabled(wireLog === "auto" ? undefined : wireLog === "on");

  const cursor = await select<"on" | "off">({
    message: "Keep Cursor diagnostics?",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On", hint: "records Cursor request/response detail" },
    ],
    initialValue: settings.cursorDiagnosticsEnabled === true ? "on" : "off",
  });
  if (isCancel(cursor)) return;
  deps.store.writeCursorDiagnosticsEnabled(cursor === "on");
  log.success(`Wire log ${wireLog} · Cursor diagnostics ${cursor}.`);
}

function summarizeModels(settings: AiGatewayStoredSettings): string {
  const models = collectGatewayModels(settings);
  if (models.length === 0) return "none exposed";
  const providers = [...new Set(models.map((model) => model.provider))].join(", ");
  return `${models.length} exposed · ${providers}`;
}

async function summarizeProviders(deps: GatewayInteractiveDeps): Promise<string> {
  try {
    const signedIn = await deps.authService.listProviderIds();
    return signedIn.length === 0 ? "none signed in" : `${signedIn.length} signed in`;
  } catch {
    return "unavailable";
  }
}

function summarizePolicy(settings: AiGatewayStoredSettings): string {
  const policy = describeGatewayPolicy(settings);
  return `compact ${policy["compact-ceiling"]} · xAI ${policy["xai-endpoint"]}`;
}

function summarizeDiagnostics(settings: AiGatewayStoredSettings): string {
  const policy = describeGatewayPolicy(settings);
  return `wire log ${policy["wire-log"]} · cursor ${policy["cursor-diagnostics"]}`;
}

export function cancelGatewayInteractive(): number {
  cancel("Cancelled.");
  return 1;
}
