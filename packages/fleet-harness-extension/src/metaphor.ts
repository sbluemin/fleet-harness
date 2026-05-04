/**
 * metaphor.ts — Metaphor 도메인 Pi 통합 진입점
 *
 * worldview, 작전명 설정, 지령 재다듬기 설정을 fleet:metaphor:settings로 통합한다.
 * 지령 재다듬기는 admiral.agent.executor.executeOneShot 기반으로 실행된다.
 */

import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  admiral,
  infra,
  metaphor,
  executeDirectiveRefinement,
  type DirectiveRefinementSettings,
  type OperationNameSettings,
  type OperationReasoningLevel,
} from "@sbluemin/fleet-core";

import { getKeybindAPI } from "./keybinds.js";
import type { Api, Model } from "./provider.js";

const {
  settings: directiveSettings,
  SECTION_KEY: DIRECTIVE_SECTION_KEY,
} = metaphor.directiveRefinement;
const {
  constants: operationConstants,
  settings: operationSettings,
  isValidReasoning: isValidOperationReasoning,
} = metaphor.operationName;
const { isWorldviewEnabled, setWorldviewEnabled } = metaphor.worldview;
const {
  loadSettings: loadDirectiveSettings,
  saveSettings: saveDirectiveSettings,
} = directiveSettings;
const {
  loadSettings: loadOperationSettings,
  saveSettings: saveOperationSettings,
} = operationSettings;
const {
  REASONING_LABELS: OPERATION_REASONING_LABELS,
  REASONING_LEVELS: OPERATION_REASONING_LEVELS,
} = operationConstants;

export function registerMetaphor(ctx: ExtensionAPI): void {
  registerMetaphorSettings(ctx);
  registerDirectiveRefinementKeybind(ctx);
}

export default registerMetaphor;

function refineDirectiveWithLoader(
  ctx: ExtensionContext,
  userDirective: string,
  settings: DirectiveRefinementSettings,
): Promise<string | null> {
  const worldviewEnabled = isWorldviewEnabled();
  const { cliType, model } = settings;
  const label = cliType
    ? `${cliType}${model ? ` · ${model}` : ""}`
    : "미설정";

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      `${worldviewEnabled ? "지령 재다듬기 가동 중..." : "프롬프트 다듬는 중..."} (${label})`,
    );
    loader.onAbort = () => done(null);

    executeDirectiveRefinement({
      worldviewEnabled,
      userDirective,
      settings,
      signal: loader.signal,
    })
      .then((result) => {
        switch (result.status) {
          case "success":
            done(result.text);
            break;
          case "aborted":
            done(null);
            break;
          case "rejected":
            ctx.ui.notify(
              `${worldviewEnabled ? "지령 재다듬기 거부됨" : "프롬프트 다듬기 거부됨"}: ${result.reason}`,
              "warning",
            );
            done(null);
            break;
          case "invalid_settings":
            ctx.ui.notify(
              `${worldviewEnabled ? "지령 재다듬기 설정 오류" : "프롬프트 다듬기 설정 오류"}: ${result.reason}`,
              "error",
            );
            done(null);
            break;
          case "error":
            ctx.ui.notify(
              `${worldviewEnabled ? "지령 재다듬기 실패" : "프롬프트 다듬기 실패"}: ${result.reason}`,
              "error",
            );
            done(null);
            break;
          default: {
            // status 추가 시 이 라인이 compile error를 발생시킨다
            const _exhaustiveCheck: never = result;
            void _exhaustiveCheck;
            done(null);
            break;
          }
        }
      })
      .catch((error) => {
        ctx.ui.notify(
          `${worldviewEnabled ? "지령 재다듬기 실패" : "프롬프트 다듬기 실패"}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        done(null);
      });

    return loader;
  });
}

let currentOperationReasoning = resolveCurrentOperationReasoning();

function registerMetaphorSettings(pi: ExtensionAPI): void {
  const worldviewAtRegister = isWorldviewEnabled();

  pi.registerCommand("fleet:metaphor:settings", {
    description: "Metaphor 설정 (worldview, 작전명, 지령 재다듬기)",
    handler: async (_args, ctx) => {
      const worldviewEnabled = isWorldviewEnabled();
      const options = [
        `Worldview: ${worldviewEnabled ? "ON" : "OFF"}`,
        "작전명 자동 생성 설정",
        "지령 재다듬기 설정",
      ];

      const choice = await ctx.ui.select("Metaphor 설정:", options);
      if (choice === undefined) return;

      if (choice.startsWith("Worldview")) {
        const next = !isWorldviewEnabled();
        setWorldviewEnabled(next);
        ctx.ui.notify(
          `Metaphor Worldview → ${next ? "ON" : "OFF"} (다음 턴부터 적용)`,
          "info",
        );
      } else if (choice.startsWith("작전명")) {
        await handleOperationNameSettings(ctx);
      } else if (choice.startsWith("지령")) {
        await handleDirectiveSettings(ctx);
      }
    },
  });

  const settingsApi = infra.settings.getSettingsService();
  settingsApi?.registerSection({
    key: DIRECTIVE_SECTION_KEY,
    displayName: "Directive Refinement",
    getDisplayFields() {
      const settings = loadDirectiveSettings();
      return [
        {
          label: "Backend",
          value: settings.cliType ?? "미설정",
          color: settings.cliType ? "accent" : "error",
        },
        {
          label: "Model",
          value: settings.model ?? "(backend default)",
          color: settings.model ? "accent" : "dim",
        },
        {
          label: "Effort",
          value: settings.effort ?? "default",
          color: settings.effort ? "warning" : "dim",
        },
      ];
    },
  });

  const keybind = getKeybindAPI();
  keybind.register({
    extension: DIRECTIVE_SECTION_KEY,
    action: "refine-directive",
    defaultKey: "alt+m",
    description: worldviewAtRegister
      ? "현재 입력을 사령부 메모 양식의 작전 지령으로 재다듬기 (스피너 + ESC 취소)"
      : "현재 입력 텍스트를 다듬기 (스피너 + ESC 취소)",
    category: "Metaphor",
    handler: async (ctx) => {
      const editorText = ctx.ui.getEditorText();
      const trimmed = editorText?.trim();

      if (!trimmed) {
        const worldviewEnabledNow = isWorldviewEnabled();
        ctx.ui.notify(
          worldviewEnabledNow
            ? "입력창에 작전 지령 초안을 먼저 작성하세요."
            : "입력창에 다듬을 텍스트를 먼저 작성하세요.",
          "warning",
        );
        return;
      }

      const settings = loadDirectiveSettings();
      if (!settings.cliType) {
        ctx.ui.notify(
          "지령 재다듬기 CLI 백엔드가 설정되지 않았습니다. /fleet:metaphor:settings 로 재설정하세요.",
          "error",
        );
        return;
      }

      const result = await refineDirectiveWithLoader(ctx, trimmed, settings);
      if (result === null) return;

      ctx.ui.setEditorText(result);
    },
  });
}

function registerDirectiveRefinementKeybind(_pi: ExtensionAPI): void {
  // Alt+M 키바인드는 registerMetaphorSettings에서 이미 등록됨
}

async function handleOperationNameSettings(ctx: any): Promise<void> {
  const currentSettings = loadOperationSettings();
  const sourceOptions = [
    `세션 모델 사용 (ctx.model)${!currentSettings.provider ? " [current]" : ""}`,
    `모델 직접 선택${currentSettings.provider ? " [current]" : ""}`,
  ];
  const sourceChoice = await ctx.ui.select(
    "작전명 생성 모델 소스:",
    sourceOptions,
  );
  if (sourceChoice === undefined) {
    ctx.ui.notify("설정이 취소되었습니다.", "warning");
    return;
  }

  const newSettings: OperationNameSettings = { reasoning: currentOperationReasoning };

  if (sourceChoice.startsWith("모델 직접 선택")) {
    const allModels = ctx.modelRegistry.getAvailable();
    if (allModels.length === 0) {
      ctx.ui.notify(
        "사용 가능한 모델이 없습니다. API 키를 설정하세요.",
        "error",
      );
      return;
    }

    const providerMap = new Map<string, Model<Api>[]>();
    for (const model of allModels) {
      const group = providerMap.get(model.provider) ?? [];
      group.push(model);
      providerMap.set(model.provider, group);
    }

    const providers = [...providerMap.keys()];
    const providerOptions = providers.map((provider) => {
      const count = providerMap.get(provider)!.length;
      const marker = provider === currentSettings.provider ? " [current]" : "";
      return `${provider} (${count} models)${marker}`;
    });

    const providerChoice = await ctx.ui.select(
      "프로바이더 선택:",
      providerOptions,
    );
    if (providerChoice === undefined) {
      ctx.ui.notify("설정이 취소되었습니다.", "warning");
      return;
    }

    const selectedProvider = providerChoice.split(" (")[0]!;
    const models = providerMap.get(selectedProvider)!;
    const modelOptions = models.map((model) => {
      const marker =
        model.provider === currentSettings.provider && model.id === currentSettings.model
          ? " [current]"
          : "";
      return `${model.id} — ${model.name}${marker}`;
    });

    const modelChoice = await ctx.ui.select(
      `${selectedProvider} 모델 선택:`,
      modelOptions,
    );
    if (modelChoice === undefined) {
      ctx.ui.notify("설정이 취소되었습니다.", "warning");
      return;
    }

    const selectedModelId = modelChoice.split(" — ")[0]!.trim();
    newSettings.provider = selectedProvider;
    newSettings.model = selectedModelId;
  }

  const reasoningOptions = OPERATION_REASONING_LEVELS.map((level) => {
    const marker = level === currentOperationReasoning ? " ✓" : "";
    return `${OPERATION_REASONING_LABELS[level]}${marker}`;
  });

  const reasoningChoice = await ctx.ui.select("Reasoning 레벨:", reasoningOptions);
  if (reasoningChoice === undefined) {
    ctx.ui.notify("설정이 취소되었습니다.", "warning");
    return;
  }

  const reasoningIdx = reasoningOptions.indexOf(reasoningChoice);
  currentOperationReasoning = OPERATION_REASONING_LEVELS[reasoningIdx]!;
  newSettings.reasoning = currentOperationReasoning;

  saveOperationSettings(newSettings);

  const modelSummary =
    newSettings.provider && newSettings.model
      ? `${newSettings.provider}/${newSettings.model}`
      : "세션 모델";
  ctx.ui.notify(
    `설정 저장 완료: 모델=${modelSummary}, reasoning=${OPERATION_REASONING_LABELS[currentOperationReasoning]}`,
    "info",
  );
}

async function handleDirectiveSettings(ctx: any): Promise<void> {
  const currentSettings = loadDirectiveSettings();
  const providers = admiral.agent.models.listProviders();

  const backendOptions = providers.map((p) => {
    const marker = p.cli === currentSettings.cliType ? " [current]" : "";
    return `${p.displayName} (${p.cli}) — ${p.modelCount} models${marker}`;
  });

  const backendChoice = await ctx.ui.select("CLI 백엔드 선택:", backendOptions);
  if (backendChoice === undefined) {
    ctx.ui.notify("설정이 취소되었습니다.", "warning");
    return;
  }

  const selectedIdx = backendOptions.indexOf(backendChoice);
  const selectedProvider = providers[selectedIdx]!;
  const selectedCli = selectedProvider.cli;

  const cliModels = admiral.agent.models.getCliModels(selectedCli);
  const noModelOption = `(backend default)${!currentSettings.model || currentSettings.cliType !== selectedCli ? " [current]" : ""}`;
  const modelOptions = [
    noModelOption,
    ...cliModels.map((m) => {
      const marker = m.id === currentSettings.model && selectedCli === currentSettings.cliType ? " [current]" : "";
      return `${m.id} — ${m.name}${marker}`;
    }),
  ];

  const modelChoice = await ctx.ui.select("모델 선택:", modelOptions);
  if (modelChoice === undefined) {
    ctx.ui.notify("설정이 취소되었습니다.", "warning");
    return;
  }

  const selectedModel = modelChoice.startsWith("(backend default)")
    ? undefined
    : modelChoice.split(" — ")[0]!.trim();

  const effortLevels = admiral.agent.models.getCliEffortLevels(selectedCli);
  let selectedEffort: string | undefined;

  if (effortLevels !== null && effortLevels.length > 0) {
    const noEffortOption = `default${!currentSettings.effort || currentSettings.cliType !== selectedCli ? " [current]" : ""}`;
    const effortOptions = [
      noEffortOption,
      ...effortLevels.map((level) => {
        const marker = level === currentSettings.effort && selectedCli === currentSettings.cliType ? " [current]" : "";
        return `${level}${marker}`;
      }),
    ];

    const effortChoice = await ctx.ui.select("Effort 레벨:", effortOptions);
    if (effortChoice === undefined) {
      ctx.ui.notify("설정이 취소되었습니다.", "warning");
      return;
    }

    selectedEffort = effortChoice.startsWith("default")
      ? undefined
      : effortChoice.split(" ")[0]!.trim();
  }

  const newSettings: DirectiveRefinementSettings = {
    cliType: selectedCli,
    model: selectedModel,
    effort: selectedEffort,
  };

  saveDirectiveSettings(newSettings);

  const summary = [
    `backend=${selectedCli}`,
    selectedModel ? `model=${selectedModel}` : "model=default",
    selectedEffort ? `effort=${selectedEffort}` : "",
  ].filter(Boolean).join(", ");

  ctx.ui.notify(`설정 저장 완료: ${summary}`, "info");
}

function resolveCurrentOperationReasoning(): OperationReasoningLevel {
  const settings = loadOperationSettings();
  return settings.reasoning && isValidOperationReasoning(settings.reasoning)
    ? settings.reasoning
    : "off";
}
